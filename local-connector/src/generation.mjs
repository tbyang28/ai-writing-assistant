import { ConnectorError } from './http.mjs';
import { PROVIDERS, modelId } from './discovery.mjs';

export const validJobId = (id) => typeof id === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 500_000) => typeof v === 'string' && v.length <= max;
const toolName = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
function requireValue(ok) { if (!ok) throw new ConnectorError('invalid_job'); }
function allowedKeys(value, keys) { return object(value) && Object.keys(value).every((key) => keys.includes(key)); }

export function validateJob(job, inventory) {
  requireValue(allowedKeys(job, ['id', 'provider', 'model', 'messages', 'tools', 'maxTokens', 'temperature']));
  requireValue(validJobId(job.id) && Object.hasOwn(PROVIDERS, job.provider) && modelId(job.model));
  const model = inventory.providers.find((p) => p.id === job.provider)?.models.find((m) => m.id === job.model);
  requireValue(Boolean(model));
  requireValue(Number.isSafeInteger(job.maxTokens) && job.maxTokens > 0 && job.maxTokens <= 131_072);
  requireValue(Number.isFinite(job.temperature) && job.temperature >= 0 && job.temperature <= 2);
  requireValue(Array.isArray(job.messages) && job.messages.length > 0 && job.messages.length <= 256);
  requireValue(job.tools === undefined || (Array.isArray(job.tools) && job.tools.length <= 64));
  const names = new Set();
  for (const tool of job.tools ?? []) {
    requireValue(allowedKeys(tool, ['name', 'description', 'parameters']) && toolName(tool.name) && text(tool.description, 10_000) && object(tool.parameters));
    requireValue(!names.has(tool.name));
    names.add(tool.name);
  }
  for (const message of job.messages) {
    requireValue(allowedKeys(message, ['role', 'content', 'toolCalls', 'toolCallId', 'toolName']));
    requireValue(['system', 'user', 'assistant', 'tool'].includes(message.role) && text(message.content));
    if (message.toolCallId !== undefined) requireValue(message.role === 'tool' && text(message.toolCallId, 256) && message.toolCallId.length > 0);
    if (message.toolName !== undefined) requireValue(message.role === 'tool' && toolName(message.toolName));
    if (message.role === 'tool') requireValue(model.tools && Boolean(message.toolCallId));
    if (message.toolCalls !== undefined) {
      requireValue(message.role === 'assistant' && model.tools && Array.isArray(message.toolCalls) && message.toolCalls.length <= 64);
      for (const call of message.toolCalls) {
        requireValue(allowedKeys(call, ['id', 'name', 'argumentsJson']) && text(call.id, 256) && call.id.length > 0 && toolName(call.name) && text(call.argumentsJson, 100_000));
      }
    }
  }
  requireValue(!names.size || model.tools);
  requireValue(Buffer.byteLength(JSON.stringify(job)) <= 1_048_576);
  return model;
}

export function serializeMessage(message) {
  if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  if (message.role === 'assistant' && message.toolCalls?.length) return {
    role: 'assistant', content: message.content || null,
    tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsJson } })),
  };
  return { role: message.role, content: message.content };
}

function parseUsage(raw) {
  if (!object(raw)) return undefined;
  const fields = {
    inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens,
    cachedInputTokens: raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens,
  };
  const entries = Object.entries(fields).filter(([, value]) => Number.isSafeInteger(value) && value >= 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

// Full SSE framing: UTF-8 split across packets, CR/LF/CRLF, comments and multiline data.
async function* frames(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], dataSize = 0, ended = false;
  function line(value) {
    if (!value) {
      const frame = data.length ? data.join('\n') : undefined;
      data = []; dataSize = 0;
      return frame;
    }
    if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /, '');
      dataSize += part.length;
      if (dataSize > 1_048_576) throw new ConnectorError('body_limit');
      data.push(part);
    }
  }
  for await (const chunk of bytes) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1_048_576) throw new ConnectorError('body_limit');
    for (;;) {
      const match = /[\r\n]/.exec(buffer);
      if (!match || (buffer[match.index] === '\r' && match.index === buffer.length - 1)) break;
      const width = buffer[match.index] === '\r' && buffer[match.index + 1] === '\n' ? 2 : 1;
      const result = line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + width);
      if (result !== undefined) { yield result; if (result === '[DONE]') { ended = true; break; } }
    }
    if (ended) return;
  }
  buffer += decoder.decode();
  // Tolerate a final SSE record without its empty-line separator.
  for (const value of buffer.split(/\r\n|\r|\n/)) {
    const result = line(value);
    if (result !== undefined) { yield result; if (result === '[DONE]') return; }
  }
  if (data.length) yield data.join('\n');
}

function* pieces(value, size = 16_384) {
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + size);
    // Keep surrogate pairs intact across event boundaries.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    yield value.slice(start, end);
    start = end;
  }
}

export async function* generate(providers, job, signal) {
  validateJob(job, providers.inventory);
  const body = {
    model: job.model, messages: job.messages.map(serializeMessage), max_tokens: job.maxTokens,
    temperature: job.temperature, stream: true,
    ...(job.tools?.length ? { tools: job.tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
  };
  const bytes = providers.transport.bytes(PROVIDERS[job.provider].chat, {
    method: 'POST', body, signal, headers: { ...providers.headers(job.provider), Accept: 'text/event-stream' },
    timeoutMs: providers.generationTimeoutMs, maxBytes: providers.maxResponseBytes,
  });
  let answer = '', rawFinish, usage, eventCount = 0;
  const calls = new Map();
  for await (const raw of frames(bytes)) {
    if (signal?.aborted) throw new ConnectorError('cancelled');
    if (raw === '[DONE]') break;
    let frame;
    try { frame = JSON.parse(raw); } catch { throw new ConnectorError('invalid_stream'); }
    if (!object(frame) || frame.error) throw new ConnectorError('invalid_stream');
    usage = parseUsage(frame.usage) ?? usage;
    if (!Array.isArray(frame.choices)) throw new ConnectorError('invalid_stream');
    if (frame.choices.length === 0) continue; // Optional usage-only chunk.
    if (frame.choices.length !== 1) throw new ConnectorError('invalid_stream');
    const choice = frame.choices[0];
    if (!object(choice) || (choice.index !== undefined && choice.index !== 0)) throw new ConnectorError('invalid_stream');
    const delta = choice.delta ?? {};
    if (!object(delta) || (rawFinish && (delta.content || delta.tool_calls?.length))) throw new ConnectorError('invalid_stream');
    if (delta.content !== undefined && delta.content !== null) {
      if (!text(delta.content)) throw new ConnectorError('invalid_stream');
      answer += delta.content;
      if (answer.length > 200_000) throw new ConnectorError('body_limit');
      for (const part of pieces(delta.content)) {
        if (++eventCount > 9999) throw new ConnectorError('body_limit');
        yield { type: 'text', text: part };
      }
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls) || !job.tools?.length) throw new ConnectorError('invalid_stream');
      for (const partial of delta.tool_calls) {
        if (!object(partial) || !Number.isSafeInteger(partial.index) || partial.index < 0 || partial.index >= 32) throw new ConnectorError('invalid_stream');
        if (partial.type !== undefined && partial.type !== 'function') throw new ConnectorError('invalid_stream');
        if (partial.function !== undefined && !object(partial.function)) throw new ConnectorError('invalid_stream');
        const fields = { id: partial.id, name: partial.function?.name, arguments: partial.function?.arguments };
        if (Object.values(fields).some((value) => value !== undefined && typeof value !== 'string')) throw new ConnectorError('invalid_stream');
        const call = calls.get(partial.index) ?? { id: '', name: '', argumentsJson: '' };
        call.id += fields.id ?? ''; call.name += fields.name ?? ''; call.argumentsJson += fields.arguments ?? '';
        if (call.id.length > 200 || call.name.length > 100 || call.argumentsJson.length > 100_000) throw new ConnectorError('body_limit');
        calls.set(partial.index, call);
        const argumentsParts = fields.arguments ? [...pieces(fields.arguments)] : [fields.arguments];
        for (let i = 0; i < argumentsParts.length; i++) {
          const part = { ...(i === 0 ? { id: fields.id, name: fields.name } : {}), arguments: argumentsParts[i] };
          if (++eventCount > 9999) throw new ConnectorError('body_limit');
          yield { type: 'tool_call_delta', index: partial.index, ...Object.fromEntries(Object.entries(part).filter(([, value]) => value !== undefined)) };
        }
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== 'string' || rawFinish) throw new ConnectorError('invalid_stream');
      rawFinish = choice.finish_reason;
    }
  }
  if (signal?.aborted) throw new ConnectorError('cancelled');
  const finishReason = ['stop', 'tool_calls', 'length', 'aborted'].includes(rawFinish) ? rawFinish
    : ['error', 'content_filter'].includes(rawFinish) ? 'error' : undefined;
  if (!finishReason) throw new ConnectorError('incomplete_stream');
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  const validCalls = toolCalls.every((call) => modelId(call.id) && job.tools?.some((tool) => tool.name === call.name));
  if (finishReason === 'tool_calls') {
    if (!toolCalls.length || !validCalls) throw new ConnectorError('invalid_stream');
  } else if (toolCalls.length && !['length', 'error', 'aborted'].includes(finishReason)) throw new ConnectorError('invalid_stream');
  const includeCalls = toolCalls.length && validCalls && ['tool_calls', 'length'].includes(finishReason);
  yield { type: 'done', result: { answer, ...(includeCalls ? { toolCalls } : {}), finishReason, rawFinishReason: rawFinish, ...(usage ? { usage } : {}) } };
}
