import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudRuntime, ConnectorRuntime, validateApiRoot } from '../src/runtime.mjs';
import { HttpTransport } from '../src/http.mjs';
import { ID, ID2, TOKEN, CODE, job, inventory, json, providers, completion, deferred, bounded } from './helpers.mjs';

function cloud(fetchImpl) { return new CloudRuntime({ apiRoot: 'https://writing.example/api', transport: new HttpTransport({ fetchImpl }), timeoutMs: 100 }); }

test('API roots only allow HTTPS or explicit loopback HTTP with an /api suffix', () => {
  for (const root of ['https://writing.example/api', 'https://writing.example/prefix/api', 'http://127.0.0.1:8001/api', 'http://localhost:8001/api', 'http://[::1]:8001/api']) assert.equal(validateApiRoot(root), root);
  for (const root of ['http://example.com/api', 'http://127.1/api', 'http://2130706433/api', 'http://0.0.0.0/api', 'http://127.0.0.1.evil/api', 'https://user:secret@example.com/api', 'https://example.com/api?key=secret', 'https://example.com/api?', 'https://example.com/api#', 'https://example.com/other', 'https://example.com/api/', 'file:///api', 'https://example.com/a/../api', 'https://example.com/a%2fapi']) {
    assert.throws(() => validateApiRoot(root), { code: 'invalid_api_root' }, root);
  }
});

test('pair/poll/status/events follow contract, default name and isolated runtime authorization', async () => {
  const requests = [];
  const service = cloud(async (url, options) => {
    const request = { url, options, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    if (url.endsWith('/pair')) return json({ connectionId: ID, token: TOKEN });
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (url.endsWith('/poll')) return json({ job: null });
    if (url.endsWith('/status')) return json({ status: 'running' });
    return json({ accepted: true });
  });
  await service.pair({ code: CODE, inventory: inventory() });
  await service.poll(inventory());
  await service.status(ID);
  await service.event(ID, 1, { type: 'text', text: '正文' });
  assert.deepEqual(requests[0].body, { version: 1, code: CODE, name: '我的电脑', inventory: inventory() });
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[1].url, 'https://writing.example/api/local-runtime/poll');
  assert.deepEqual(requests[1].body, { inventory: inventory() });
  assert.equal(requests[2].options.method, 'GET');
  assert.equal(requests[2].body, undefined);
  assert.deepEqual(requests[3].body, { seq: 1, event: { type: 'text', text: '正文' } });
  assert.equal(requests.every((r) => r.options.redirect === 'manual'), true);
  service.clear();
  await assert.rejects(service.poll(inventory()), { code: 'not_paired' });
});

test('pair expiration/rejection and forged runtime tokens never proceed', async () => {
  for (const status of [401, 403, 404, 410]) {
    const service = cloud(async () => json({ detail: 'SECRET_BODY' }, status));
    await assert.rejects(service.pair({ code: CODE, inventory: inventory() }), { code: 'http', status });
    assert.equal(service.token, undefined);
  }
  const service = cloud(async () => json({ connectionId: ID, token: 'USER_JWT_OR_LOCAL_KEY' }));
  await assert.rejects(service.pair({ code: CODE, inventory: inventory() }), { code: 'invalid_pair_response' });
});

test('events retry an identical seq/body once after lost response, never retry HTTP conflict or regenerate', async () => {
  const bodies = [];
  const service = cloud(async (_url, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) throw new Error('response lost after server accepted event');
    return json({ accepted: true });
  });
  service.token = TOKEN;
  await service.event(ID, 1, { type: 'text', text: '正文' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  let count = 0;
  const conflict = cloud(async () => { count++; return json({ detail: 'SECRET_BODY' }, 409); });
  conflict.token = TOKEN;
  await assert.rejects(conflict.event(ID, 2, { type: 'text', text: 'x' }), { code: 'event_delivery' });
  assert.equal(count, 1);
  count = 0;
  const disconnected = cloud(async () => { count++; throw new Error('SECRET'); });
  disconnected.token = TOKEN;
  await assert.rejects(disconnected.event(ID, 1, { type: 'text', text: 'x' }), { code: 'event_delivery' });
  assert.equal(count, 2);
});

test('event delivery backpressure waits for each ack, delivery ambiguity emits no replacement failure', async () => {
  const first = deferred(), entered = deferred();
  let generations = 0;
  const local = providers(async () => { generations++; return new Response(completion('正文')); });
  const sent = [];
  const service = {
    event: async (_id, seq, event) => { sent.push({ seq, event }); if (seq === 1) { entered.resolve(); await first.promise; } },
    status: async () => 'running',
  };
  const runtime = new ConnectorRuntime({ cloud: service, providers: local });
  const running = runtime.runJob(job(), new AbortController().signal);
  await bounded(entered.promise);
  assert.equal(sent.length, 1);
  first.resolve();
  await bounded(running);
  assert.deepEqual(sent.map((entry) => entry.seq), [1, 2]);
  assert.equal(generations, 1);
  const failed = [];
  service.event = async (_id, seq, event) => { failed.push({ seq, event }); throw new Error('lost'); };
  await runtime.runJob(job(), new AbortController().signal);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].event.type, 'text');
  assert.equal(generations, 2);
});

test('total event budget includes the repeated final answer and ends with fixed failure before overflow', async () => {
  const answer = '中'.repeat(190_000);
  const local = providers(async () => new Response(completion(answer)));
  const events = [];
  const service = { status: async () => 'running', event: async (_id, seq, event) => { assert.equal(seq, events.length + 1); events.push(event); } };
  await new ConnectorRuntime({ cloud: service, providers: local }).runJob(job(), new AbortController().signal);
  assert.equal(events.at(-1).type, 'failure');
  assert.equal(events.some((event) => event.type === 'done'), false);
  assert.ok(events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= 1_000_000);
});

test('status cancellation independently aborts a hung generation, without terminal success', async () => {
  let requestSignal, bodyCancelled = false, statusCalls = 0;
  const local = providers(async (_url, options) => {
    requestSignal = options.signal;
    return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
  });
  const events = [];
  const runtime = new ConnectorRuntime({ providers: local, statusMs: 20,
    cloud: { status: async () => { statusCalls++; return 'cancelled'; }, event: async (_id, _seq, event) => events.push(event) },
  });
  await bounded(runtime.runJob(job(), new AbortController().signal));
  assert.equal(requestSignal.aborted, true);
  assert.equal(bodyCancelled, true);
  assert.equal(statusCalls, 1);
  assert.deepEqual(events, []);
});

test('status failure aborts local HTTP; timeout/unsafe jobs send only fixed failure descriptions', async () => {
  const output = [];
  const local = providers(async () => new Response(new ReadableStream()));
  const service = { status: async () => { throw new Error('UPSTREAM_PRIVATE'); }, event: async (_id, _seq, event) => output.push(event) };
  await bounded(new ConnectorRuntime({ cloud: service, providers: local, statusMs: 15 }).runJob(job(), new AbortController().signal));
  assert.deepEqual(output, []);
  service.status = async () => 'running';
  await bounded(new ConnectorRuntime({ cloud: service, providers: local, jobTimeoutMs: 15 }).runJob(job(), new AbortController().signal));
  assert.deepEqual(output, [{ type: 'failure', message: '本地模型响应超时' }]);
  output.length = 0;
  await new ConnectorRuntime({ cloud: service, providers: local }).runJob(job({ command: 'PRIVATE_SECRET' }), new AbortController().signal);
  assert.deepEqual(output, [{ type: 'failure', message: '本地任务未通过安全或能力校验' }]);
});

test('poll and inventory heartbeat continue during generation, duplicate jobs never regenerate', async () => {
  const stop = new AbortController(), started = deferred(), finished = deferred();
  let polls = 0, discoveries = 0, generations = 0, statuses = 0;
  const local = providers(async () => {
    generations++;
    return new Response(new ReadableStream({ start() { started.resolve(); } }));
  });
  local.discover = async () => { discoveries++; return local.inventory; };
  const service = {
    pair: async () => {}, clear: () => {},
    poll: async () => { polls++; if (polls >= 5 && discoveries >= 2 && statuses) { stop.abort(); finished.resolve(); } return job(); },
    status: async () => { statuses++; return 'running'; }, event: async () => {},
  };
  const runtime = new ConnectorRuntime({ cloud: service, providers: local, pollMs: 15, inventoryMs: 20, statusMs: 15 });
  await bounded(runtime.run({ code: CODE, signal: stop.signal }));
  await bounded(started.promise);
  await bounded(finished.promise);
  assert.equal(generations, 1);
  assert.ok(polls >= 5);
  assert.ok(discoveries >= 2);
  assert.ok(statuses >= 1);
  assert.equal(runtime.active.size, 0);
});

test('two jobs run concurrently and fatal poll revocation aborts both and clears token', async () => {
  const started = [];
  const local = providers(async (_url, options) => { started.push(options.signal); return new Response(new ReadableStream()); });
  local.discover = async () => local.inventory;
  let polls = 0, cleared = false;
  const service = {
    pair: async () => {}, clear: () => { cleared = true; },
    poll: async () => { polls++; if (polls < 3) return job({ id: polls === 1 ? ID : ID2 }); const error = new Error('http'); error.code = 'http'; error.status = 403; throw error; },
    status: async () => 'running', event: async () => {},
  };
  const runtime = new ConnectorRuntime({ cloud: service, providers: local, pollMs: 15 });
  await bounded(assert.rejects(runtime.run({ code: CODE }), { code: 'http', status: 403 }));
  assert.equal(started.length, 2);
  assert.equal(started.every((signal) => signal.aborted), true);
  assert.equal(cleared, true);
  assert.equal(runtime.active.size, 0);
});
