import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, validateJob } from '../src/generation.mjs';
import { PROVIDERS } from '../src/discovery.mjs';
import { job, inventory, providers, chunk, completion, collect, bounded } from './helpers.mjs';

const tool = { name: 'get_outline', description: '读取大纲', parameters: { type: 'object', properties: {} } };

test('serializes camelCase chat history and tools to OpenAI wire format at fixed endpoint', async () => {
  let requested;
  const local = providers(async (url, options) => {
    requested = { url, options, body: JSON.parse(options.body) };
    return new Response(completion());
  }, { ollamaKey: 'LOCAL_ONLY_KEY' });
  const messages = [
    { role: 'system', content: '你是作者' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_outline', argumentsJson: '{}' }] },
    { role: 'tool', content: '大纲内容', toolCallId: 'call_1', toolName: 'get_outline' },
    { role: 'user', content: '继续' },
  ];
  const events = await collect(generate(local, job({ messages, tools: [tool] })));
  assert.equal(requested.url, PROVIDERS.ollama.chat);
  assert.equal(requested.options.headers.Authorization, 'Bearer LOCAL_ONLY_KEY');
  assert.equal(requested.options.redirect, 'manual');
  assert.deepEqual(requested.body.messages, [
    messages[0], { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_outline', arguments: '{}' } }] },
    { role: 'tool', content: '大纲内容', tool_call_id: 'call_1' }, messages[3],
  ]);
  assert.deepEqual(requested.body.tools, [{ type: 'function', function: tool }]);
  assert.equal(requested.body.max_tokens, 512);
  assert.equal(requested.body.stream, true);
  assert.equal(events.at(-1).result.answer, '本机正文');
  assert.equal(Object.hasOwn(events.at(-1).result, 'usage'), false);
});

test('SSE handles split UTF-8, CRLF, multiline records, tool deltas and optional usage', async () => {
  const source = ': comment\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"正文"},"finish_reason":null}]}\r\n\r\n'
    + chunk({ tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'get_', arguments: '{' } }] })
    + chunk({ tool_calls: [{ index: 0, id: '1', function: { name: 'outline', arguments: '}' } }] })
    + chunk({}, 'tool_calls')
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\n`
    + 'data: [DONE]\n\n';
  const encoded = Buffer.from(source);
  let cancelled = false;
  const local = providers(async () => new Response(new ReadableStream({
    start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); },
    cancel() { cancelled = true; },
  })));
  const events = await collect(generate(local, job({ tools: [tool] })));
  assert.deepEqual(events[0], { type: 'text', text: '正文' });
  assert.deepEqual(events[1], { type: 'tool_call_delta', index: 0, id: 'call_', name: 'get_', arguments: '{' });
  assert.deepEqual(events.at(-1), { type: 'done', result: {
    answer: '正文', toolCalls: [{ id: 'call_1', name: 'get_outline', argumentsJson: '{}' }],
    finishReason: 'tool_calls', rawFinishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 4, reasoningTokens: 3 },
  } });
  assert.equal(cancelled, true);
});

test('explicit finish without sentinel is accepted; length and error remain incomplete terminal results', async () => {
  for (const reason of ['stop', 'length', 'error', 'content_filter', 'aborted']) {
    const events = await collect(generate(providers(async () => new Response(chunk({ content: 'partial' }, reason))), job()));
    assert.equal(events.at(-1).result.finishReason, reason === 'content_filter' ? 'error' : reason);
  }
});

test('unknown/missing terminal, error frames, malformed SSE and forged tools never become success', async () => {
  const bad = [
    'data: [DONE]\n\n', chunk({ content: 'partial' }), chunk({}, 'invented') + 'data: [DONE]\n\n',
    'data: {"error":{"message":"SECRET_KEY"}}\n\n', 'data: not-json-SECRET\n\n',
    chunk({ tool_calls: [{ index: -1, function: { arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'exec', arguments: '{}' } }] }, 'tool_calls'),
    chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'get_outline', arguments: '{}' } }] }, 'stop'),
    chunk({}, 'stop') + chunk({ content: 'extra' }),
  ];
  for (const source of bad) {
    await assert.rejects(collect(generate(providers(async () => new Response(source)), job({ tools: [tool] }))), (error) => {
      assert.equal(error.message.includes('SECRET'), false); return true;
    });
  }
});

test('malicious jobs, non-inventory models, unsupported tools and oversized input are rejected before HTTP', async () => {
  let calls = 0;
  const local = providers(async () => { calls++; throw new Error('must not call'); });
  const bad = [
    { url: 'http://169.254.169.254/' }, { endpoint: 'http://localhost:8000' }, { command: 'rm -rf /' },
    { provider: '__proto__' }, { provider: 'evil' }, { model: 'not-in-inventory' }, { id: '../other/events' },
    { maxTokens: Infinity }, { maxTokens: -1 }, { temperature: 100 }, { messages: [] },
    { messages: [{ role: 'user', content: 'x', url: 'http://evil' }] },
    { messages: [{ role: 'tool', content: '{}', toolCallId: '' }] },
    { messages: [{ role: 'user', content: 'x'.repeat(500_001) }] },
    { tools: [{ ...tool, command: 'shell' }] },
    { provider: 'lmstudio', model: 'local-writer', tools: [tool] },
    { provider: 'lmstudio', model: 'local-writer', messages: [{ role: 'tool', content: '{}', toolCallId: '1' }] },
    { provider: 'lmstudio', model: 'local-writer', messages: [{ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'x', argumentsJson: '{}' }] }] },
  ];
  for (const overrides of bad) await assert.rejects(collect(generate(local, job(overrides))), { code: 'invalid_job' });
  assert.equal(calls, 0);
  local.inventory = { providers: [], detectedClis: [] };
  assert.throws(() => validateJob(job(), local.inventory), { code: 'invalid_job' });
  assert.doesNotThrow(() => validateJob(job({ provider: 'lmstudio', model: 'local-writer' }), inventory()));
});

test('large upstream deltas are split to API event limits without breaking Unicode or tool arguments', async () => {
  const answer = 'x'.repeat(16_383) + '😀' + '中'.repeat(20_000);
  const argumentsJson = JSON.stringify({ text: 'x'.repeat(40_000) });
  const source = chunk({ content: answer }) + chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_outline', arguments: argumentsJson } }] }) + chunk({}, 'tool_calls');
  const events = await collect(generate(providers(async () => new Response(source)), job({ tools: [tool] })));
  const texts = events.filter((event) => event.type === 'text');
  const deltas = events.filter((event) => event.type === 'tool_call_delta');
  assert.equal(texts.map((event) => event.text).join(''), answer);
  assert.equal(deltas.map((event) => event.arguments ?? '').join(''), argumentsJson);
  assert.ok(texts.every((event) => event.text.length <= 16_384 && !/[\uD800-\uDBFF]$/.test(event.text)));
  assert.ok(deltas.every((event) => (event.arguments?.length ?? 0) <= 16_384));
  assert.equal(deltas[0].id, 'call_1');
  assert.equal(deltas[1].id, undefined);
  assert.equal(events.at(-1).result.answer, answer);
});

test('length with unfinished tool metadata remains length and omits an invalid completed tool call', async () => {
  const source = chunk({ tool_calls: [{ index: 0, function: { arguments: '{' } }] }) + chunk({}, 'length');
  const events = await collect(generate(providers(async () => new Response(source)), job({ tools: [tool] })));
  assert.equal(events.at(-1).result.finishReason, 'length');
  assert.equal(events.at(-1).result.toolCalls, undefined);
});

test('local generation refuses redirects, honors deadlines/body limits, and abort releases stream', async () => {
  const redirected = providers(async () => new Response(null, { status: 302, headers: { location: 'http://evil' } }));
  await assert.rejects(collect(generate(redirected, job())), { code: 'http' });
  const stalled = providers(async () => new Response(new ReadableStream()), { generationTimeoutMs: 15 });
  await bounded(assert.rejects(collect(generate(stalled, job())), { code: 'timeout' }));
  const oversized = providers(async () => new Response(completion('x'.repeat(1000))), { maxResponseBytes: 100 });
  await assert.rejects(collect(generate(oversized, job())), { code: 'body_limit' });
  const controller = new AbortController();
  let cancelled = false;
  const cancellable = providers(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(Buffer.from(chunk({ content: 'first' }))); },
    cancel() { cancelled = true; },
  })));
  const iterator = generate(cancellable, job(), controller.signal);
  assert.equal((await iterator.next()).value.type, 'text');
  const pending = iterator.next();
  controller.abort();
  await bounded(assert.rejects(pending, { code: 'cancelled' }));
  assert.equal(cancelled, true);
});
