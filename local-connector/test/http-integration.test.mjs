import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { HttpTransport } from '../src/http.mjs';
import { LocalProviders, PROVIDERS } from '../src/discovery.mjs';
import { CloudRuntime, ConnectorRuntime } from '../src/runtime.mjs';
import { ID, TOKEN, CODE, job, chunk, deferred, bounded } from './helpers.mjs';

async function serve(handler) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.destroy(); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    root: `http://127.0.0.1:${server.address().port}`,
    async close() { const stopped = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await stopped; },
  };
}
async function body(req) { let raw = ''; for await (const data of req) raw += data; return raw ? JSON.parse(raw) : undefined; }
function respond(res, data) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

// Tests map only the exact production constants to ephemeral HTTP endpoints.
// No product flag or constructor option can relax the provider URL allowlist.
function mappedTransport(root) {
  const mapping = new Map([
    [PROVIDERS.ollama.list, '/ollama/api/tags'], [PROVIDERS.ollama.show, '/ollama/api/show'],
    [PROVIDERS.ollama.chat, '/ollama/v1/chat/completions'], [PROVIDERS.lmstudio.list, '/lmstudio/v1/models'],
    [PROVIDERS.lmstudio.chat, '/lmstudio/v1/chat/completions'],
  ]);
  return new HttpTransport({ fetchImpl: (url, options) => {
    assert.ok(mapping.has(url), `Unexpected provider URL ${url}`);
    return fetch(`${root}${mapping.get(url)}`, options);
  } });
}

test('real HTTP pairing/discovery/SSE/events: ack loss deduplicates, heartbeat/status stay live, one generation', async () => {
  const stop = new AbortController(), done = deferred();
  const accepted = [], attempts = new Map();
  let polls = 0, statuses = 0, generations = 0, listRequests = 0, stream, streamEnded = false;
  const errors = [];
  function release() {
    if (stream && !streamEnded && polls >= 4 && statuses >= 1) {
      streamEnded = true;
      stream.end(chunk({ content: '续写完成' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    }
  }
  const server = await serve(async (req, res) => {
    try {
      const data = await body(req);
      if (req.url.startsWith('/api/')) {
        assert.equal(req.headers.authorization, req.url.endsWith('/pair') ? undefined : `Bearer ${TOKEN}`);
        assert.equal(JSON.stringify(data ?? {}).includes('LOCAL_KEY'), false);
      } else {
        assert.equal(req.headers.authorization, `Bearer ${req.url.startsWith('/ollama') ? 'OLLAMA_LOCAL_KEY' : 'LM_LOCAL_KEY'}`);
      }
      if (req.url === '/ollama/api/tags') { listRequests++; return respond(res, { models: [{ name: 'writer:latest' }] }); }
      if (req.url === '/ollama/api/show') return respond(res, { capabilities: ['tools'], model_info: { 'llama.context_length': 4096 } });
      if (req.url === '/lmstudio/v1/models') return respond(res, { data: [{ id: 'local-writer' }] });
      if (req.url === '/api/local-runtime/pair') {
        assert.equal(data.version, 1); assert.equal(data.code, CODE); assert.equal(data.name, '我的电脑');
        assert.deepEqual(data.inventory.detectedClis, ['codex']);
        assert.equal(data.inventory.providers[0].models[0].tools, true);
        return respond(res, { connectionId: ID, token: TOKEN });
      }
      if (req.url === '/api/local-runtime/poll') {
        polls++; release(); assert.ok(data.inventory.providers.length > 0);
        return respond(res, { job: polls === 1 || polls === 3 ? job() : null });
      }
      if (req.url === `/api/local-runtime/jobs/${ID}/status`) { statuses++; respond(res, { status: 'running' }); release(); return; }
      if (req.url === '/ollama/v1/chat/completions') {
        generations++; assert.equal(data.model, 'writer:latest'); assert.equal(data.messages[0].content, '继续写作');
        stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const first = Buffer.from(chunk({ content: '本机' }));
        res.write(first.subarray(0, 9)); res.write(first.subarray(9)); release(); return;
      }
      if (req.url === `/api/local-runtime/jobs/${ID}/events`) {
        const serialized = JSON.stringify(data), previous = attempts.get(data.seq);
        if (previous) assert.equal(serialized, previous);
        else { assert.equal(data.seq, accepted.length + 1); attempts.set(data.seq, serialized); accepted.push(data.event); }
        if (data.seq === 1 && !previous) { res.destroy(); return; } // accepted, response lost
        respond(res, { accepted: true }); return;
      }
      assert.fail(`Unexpected request ${req.url}`);
    } catch (error) { errors.push(error); res.destroy(); }
  });
  const providers = new LocalProviders({ transport: mappedTransport(server.root), ollamaKey: 'OLLAMA_LOCAL_KEY', lmstudioKey: 'LM_LOCAL_KEY', cliDetector: async () => ['codex'] });
  const cloud = new CloudRuntime({ apiRoot: `${server.root}/api` });
  const originalEvent = cloud.event.bind(cloud);
  cloud.event = async (...args) => { await originalEvent(...args); if (args[2].type === 'done') done.resolve(); };
  const runtime = new ConnectorRuntime({ cloud, providers, pollMs: 20, inventoryMs: 30, statusMs: 50 });
  const running = runtime.run({ code: CODE, signal: stop.signal });
  try {
    await bounded(done.promise, 5000);
    stop.abort();
    await bounded(running);
    assert.deepEqual(errors, []);
    assert.equal(generations, 1);
    assert.ok(polls >= 4);
    assert.ok(statuses >= 1);
    assert.ok(listRequests >= 2);
    assert.deepEqual(accepted.map((event) => event.type), ['text', 'text', 'done']);
    assert.equal(accepted.at(-1).result.answer, '本机续写完成');
    assert.equal(accepted.at(-1).result.finishReason, 'stop');
    assert.equal(cloud.token, undefined);
  } finally { stop.abort(); await bounded(running).catch(() => {}); await server.close(); }
});

test('real HTTP status cancellation closes a streaming provider socket', async () => {
  const disconnected = deferred();
  let generated = false, statusChecks = 0;
  const events = [];
  const server = await serve(async (req, res) => {
    const data = await body(req);
    if (req.url === '/ollama/v1/chat/completions') {
      generated = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n');
      res.on('close', () => disconnected.resolve()); return;
    }
    if (req.url.endsWith('/status')) { statusChecks++; return respond(res, { status: 'cancelled' }); }
    if (req.url.endsWith('/events')) { events.push(data); return respond(res, { accepted: true }); }
    res.writeHead(404); res.end();
  });
  const local = new LocalProviders({ transport: mappedTransport(server.root) });
  local.inventory = { providers: [{ id: 'ollama', models: [{ id: 'writer:latest', label: 'writer:latest', tools: true }] }], detectedClis: [] };
  const cloud = new CloudRuntime({ apiRoot: `${server.root}/api` }); cloud.token = TOKEN;
  try {
    await bounded(new ConnectorRuntime({ cloud, providers: local, statusMs: 50 }).runJob(job(), new AbortController().signal));
    await bounded(disconnected.promise);
    assert.equal(generated, true);
    assert.equal(statusChecks, 1);
    assert.deepEqual(events, []);
  } finally { await server.close(); }
});
