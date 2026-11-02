import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, request, type Dispatcher } from 'undici';

import {
  LlmHttpError, LlmIncompleteError, recordLlmFailure,
  type ChatMessage, type LlmCallOptions, type LlmClient, type LlmResult,
  type LlmFinishReason, type LlmUsage, type LlmAttempt, type LlmStreamEvent, type LlmToolCall,
} from './llm-client.interface';

type UndiciResponse = Dispatcher.ResponseData<null>;
export const EMBEDDING_MODEL = 'BAAI/bge-large-zh-v1.5';

@Injectable()
export class SiliconFlowClient implements LlmClient, OnModuleDestroy {
  private readonly agent = new Agent({ connections: 10, connect: { timeout: 15_000 },
    headersTimeout: 180_000, bodyTimeout: 300_000 });

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> { await this.agent.close(); }

  private requireApiKey(): string {
    const key = this.config.getOrThrow<string>('SILICONFLOW_API_KEY');
    if (!key) throw new Error('Render 后端未配置 SILICONFLOW_API_KEY，无法调用 AI 服务');
    return key;
  }

  private buildBody(options: LlmCallOptions, stream: boolean): string {
    const body: Record<string, unknown> = {
      model: options.model ?? this.config.getOrThrow<string>('DEEPSEEK_MODEL'),
      messages: options.messages.map(serializeMessage), stream,
      max_tokens: options.maxTokens ?? 4096, temperature: options.temperature ?? 0.7,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    return JSON.stringify(body);
  }

  private post(path: string, body: string, signal?: AbortSignal): Promise<UndiciResponse> {
    signal?.throwIfAborted();
    return request(`${this.config.getOrThrow<string>('SILICONFLOW_BASE_URL')}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.requireApiKey()}`,
        'content-type': 'application/json' }, body, dispatcher: this.agent, signal,
    });
  }

  private static async httpError(res: UndiciResponse): Promise<LlmHttpError> {
    const bodyText = await res.body.text().catch(() => '');
    let body: unknown;
    try { body = JSON.parse(bodyText); } catch { body = undefined; }
    return new LlmHttpError(res.statusCode, body, bodyText);
  }

  async chat(options: LlmCallOptions): Promise<LlmResult> {
    const body = this.buildBody(options, false);
    const attempts: LlmAttempt[] = [];
    return this.withRetry(async () => {
      const started = performance.now();
      try {
        const res = await this.post('/chat/completions', body, options.signal);
        if (res.statusCode >= 400) throw await SiliconFlowClient.httpError(res);
        const data = await res.body.json() as Completion;
        const choice = data.choices?.[0];
        if (!choice?.message) throw new LlmIncompleteError('error');
        const usage = parseUsage(data.usage);
        if (choice.message.tool_calls?.length && !['tool_calls', 'length'].includes(choice.finish_reason ?? '')) {
          throw new LlmIncompleteError('error');
        }
        attempts.push({ status: 'completed', durationMs: performance.now() - started, usage });
        return { answer: choice.message.content ?? '', toolCalls: parseCalls(choice.message.tool_calls),
          finishReason: finishReason(choice.finish_reason), rawFinishReason: choice.finish_reason ?? undefined,
          usage, attempts };
      } catch (error) {
        attempts.push({ status: 'failed', durationMs: performance.now() - started });
        recordLlmFailure(error, attempts);
        throw error;
      }
    }, options.signal);
  }

  /** 统一流：文本、工具参数片段及终态；流开始后不自动重试以免重复输出/副作用。 */
  async *streamEvents(options: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
    const started = performance.now();
    const res = await this.post('/chat/completions', this.buildBody(options, true), options.signal);
    if (res.statusCode >= 400) throw await SiliconFlowClient.httpError(res);
    const decoder = new TextDecoder();
    let buffer = '', answer = '', rawFinish: string | undefined;
    let usage: LlmUsage | undefined;
    let sawDone = false;
    const calls = new Map<number, LlmToolCall>();
    const parseLine = (line: string): LlmStreamEvent[] => {
      const events: LlmStreamEvent[] = [];
      if (!line.startsWith('data:')) return events;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') { sawDone = true; return events; }
      let frame: Completion;
      try { frame = JSON.parse(raw) as Completion; } catch { return events; }
      if (frame.error) throw new LlmIncompleteError('error');
      if (frame.usage) usage = parseUsage(frame.usage);
      const choice = frame.choices?.[0];
      if (!choice) return events;
      if (choice.finish_reason) rawFinish = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) { answer += delta.content; events.push({ type: 'text', text: delta.content }); }
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index;
        if (!Number.isSafeInteger(index) || index! < 0 || index! > 63) throw new LlmIncompleteError('error');
        let call = calls.get(index!);
        if (!call) { call = { id: '', name: '', argumentsJson: '' }; calls.set(index!, call); }
        if (tc.id) call.id += tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') call.argumentsJson += tc.function.arguments;
        // 参数只在完成帧后校验执行。限制异常上游占用的内存。
        if (call.argumentsJson.length > 100_000 || answer.length > 500_000) throw new LlmIncompleteError('error');
        events.push({ type: 'tool_call_delta', index: index!, id: tc.id,
          name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : undefined });
      }
      return events;
    };
    try {
      for await (const chunk of res.body) {
        options.signal?.throwIfAborted();
        buffer += decoder.decode(chunk as Buffer, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          for (const event of parseLine(line)) yield event;
          if (sawDone) break;
        }
        if (sawDone) break;
        if (buffer.length > 1_000_000 || answer.length > 500_000) throw new LlmIncompleteError('error');
      }
      if (!sawDone) {
        buffer += decoder.decode();
        for (const event of parseLine(buffer.trimEnd())) yield event;
      }
      options.signal?.throwIfAborted();
      if (!sawDone && !rawFinish) throw new LlmIncompleteError('error');
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      if (toolCalls.length && !['tool_calls', 'length'].includes(rawFinish ?? '')) throw new LlmIncompleteError('error');
      yield { type: 'done', result: { answer, toolCalls, finishReason: finishReason(rawFinish),
        rawFinishReason: rawFinish, usage,
        attempts: [{ status: 'completed', durationMs: performance.now() - started, usage }] } };
    } finally {
      // 不等待无止境的 dump；[DONE]、消费者退出、取消均释放上游 socket。
      if (!res.body.destroyed) res.body.destroy();
    }
  }

  async *chatStream(options: LlmCallOptions): AsyncIterable<string> {
    for await (const event of this.streamEvents(options)) {
      if (event.type === 'text') yield event.text;
      if (event.type === 'done' && ['length', 'error', 'aborted'].includes(event.result.finishReason ?? '')) {
        throw new LlmIncompleteError(event.result.finishReason!);
      }
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const body = JSON.stringify({ model: EMBEDDING_MODEL, input: texts });
    return this.withRetry(async () => {
      const res = await this.post('/embeddings', body, signal);
      if (res.statusCode >= 400) throw await SiliconFlowClient.httpError(res);
      const data = await res.body.json() as { data: Array<{ embedding: number[] }> };
      return data.data.map((item) => item.embedding);
    }, signal);
  }

  private async withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      try { return await fn(); } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        // 仅网络错误重试；解析/业务错误不能隐式重复请求。
        if (error instanceof LlmHttpError || error instanceof LlmIncompleteError || error instanceof SyntaxError) throw error;
      }
    }
    throw lastError;
  }
}

type WireCall = { id?: string; index?: number; function?: { name?: string; arguments?: unknown } };
type Completion = {
  error?: unknown;
  choices?: Array<{ finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: WireCall[] };
    delta?: { content?: string | null; tool_calls?: WireCall[] } }>;
  usage?: Record<string, unknown>;
};

function parseCalls(calls: WireCall[] = []): LlmToolCall[] {
  return calls.map((tc) => ({ id: tc.id ?? '', name: tc.function?.name ?? '',
    argumentsJson: typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{invalid tool arguments' }));
}

function finishReason(raw?: string | null): LlmFinishReason {
  if (raw === 'stop' || raw === 'tool_calls' || raw === 'length') return raw;
  if (raw === 'content_filter' || raw === 'error') return 'error';
  return 'unknown';
}

function parseUsage(raw?: Record<string, unknown>): LlmUsage | undefined {
  if (!raw) return undefined;
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const details = raw.completion_tokens_details as Record<string, unknown> | undefined;
  const promptDetails = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  return { inputTokens: count(raw.prompt_tokens), outputTokens: count(raw.completion_tokens),
    cachedInputTokens: count(raw.prompt_cache_hit_tokens ?? promptDetails?.cached_tokens),
    reasoningTokens: count(details?.reasoning_tokens) };
}

function serializeMessage(msg: ChatMessage): Record<string, unknown> {
  if (msg.role === 'tool') return { role: 'tool', tool_call_id: msg.toolCallId ?? '', content: msg.content };
  if (msg.role === 'assistant' && msg.toolCalls?.length) return {
    role: 'assistant', content: msg.content || null,
    tool_calls: msg.toolCalls.map((tc) => ({ id: tc.id, type: 'function',
      function: { name: tc.name, arguments: tc.argumentsJson } })),
  };
  return { role: msg.role, content: msg.content };
}
