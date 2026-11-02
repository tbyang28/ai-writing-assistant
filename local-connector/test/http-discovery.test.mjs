import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { HttpTransport } from '../src/http.mjs';
import { LocalProviders, PROVIDERS, detectClis } from '../src/discovery.mjs';
import { json, bounded } from './helpers.mjs';

const transport = (fetchImpl) => new HttpTransport({ fetchImpl });

test('HTTP refuses redirects and never exposes upstream bodies or network messages', async () => {
  let cancelled = false;
  const http = transport(async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: 'http://evil.invalid/secret' } });
  });
  await assert.rejects(http.json(PROVIDERS.ollama.list), { code: 'http', status: 302 });
  assert.equal(cancelled, true);
  await assert.rejects(transport(async () => json({ error: 'API_KEY_PRIVATE' }, 500)).json(PROVIDERS.ollama.list), (error) => {
    assert.equal(error.message, 'http'); assert.equal(Object.hasOwn(error, 'body'), false); return true;
  });
  await assert.rejects(transport(async () => { throw new Error('API_KEY_PRIVATE'); }).json(PROVIDERS.ollama.list), { message: 'network' });
});

test('deadlines cover fetch and stalled response reads, even if injected fetch ignores abort', async () => {
  await bounded(assert.rejects(transport(() => new Promise(() => {})).json(PROVIDERS.ollama.list, { timeoutMs: 15 }), { code: 'timeout' }));
  let signal, cancelled = false;
  const http = transport(async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  await bounded(assert.rejects(http.json(PROVIDERS.ollama.list, { timeoutMs: 15 }), { code: 'timeout' }));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('HTTP enforces declared and streamed body limits and sanitizes bad JSON', async () => {
  await assert.rejects(transport(async () => new Response('x', { headers: { 'content-length': '999' } })).json(PROVIDERS.ollama.list, { maxBytes: 8 }), { code: 'body_limit' });
  await assert.rejects(transport(async () => new Response('123456789')).json(PROVIDERS.ollama.list, { maxBytes: 8 }), { code: 'body_limit' });
  await assert.rejects(transport(async () => new Response('secret-invalid-json')).json(PROVIDERS.ollama.list), { message: 'invalid_response' });
});

test('caller abort cancels a pending body read', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const http = transport(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const reading = http.json(PROVIDERS.lmstudio.list, { signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await bounded(assert.rejects(reading, { code: 'cancelled' }));
  assert.equal(cancelled, true);
});

test('an already-aborted request never initiates HTTP', async () => {
  let requests = 0;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transport(async () => { requests++; return json({}); }).json(PROVIDERS.ollama.list, { signal: controller.signal }), { code: 'cancelled' });
  assert.equal(requests, 0);
});

test('fixed discovery caps/deduplicates models, verifies Ollama tools/context, never generates', async () => {
  const requests = [];
  const ollamaKey = 'OLLAMA_SECRET', studioKey = 'STUDIO_SECRET';
  const local = new LocalProviders({
    ollamaKey, lmstudioKey: studioKey, cliDetector: async () => ['codex'],
    transport: transport(async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.redirect, 'manual');
      if (url === PROVIDERS.ollama.list) return json({ models: [...Array.from({ length: 25 }, (_, i) => ({ name: `m${i}` })), { name: 'm0' }, { name: '' }] });
      if (url === PROVIDERS.ollama.show) {
        const { model } = JSON.parse(options.body);
        if (model === 'm1') return json({ error: 'SECRET' }, 401);
        return json({ capabilities: model === 'm0' ? ['completion', 'tools'] : ['completion'], model_info: { 'llama.context_length': 8192, 'other.context_length': -1 } });
      }
      if (url === PROVIDERS.lmstudio.list) return json({ data: [{ id: 'studio', tools: true, contextWindow: 999999 }, { id: 'studio' }] });
      assert.fail(`Unexpected URL ${url}`);
    }),
  });
  const result = await local.discover();
  assert.equal(result.providers[0].models.length, 20);
  assert.deepEqual(result.providers[0].models[0], { id: 'm0', label: 'm0', tools: true, contextWindow: 8192 });
  assert.deepEqual(result.providers[0].models[1], { id: 'm1', label: 'm1', tools: false });
  assert.deepEqual(result.providers[1], { id: 'lmstudio', models: [{ id: 'studio', label: 'studio', tools: false }] });
  assert.deepEqual(result.detectedClis, ['codex']);
  assert.equal(requests.length, 22);
  for (const { url, options } of requests) {
    assert.equal(options.headers.Authorization, `Bearer ${url.includes(':11434') ? ollamaKey : studioKey}`);
    assert.equal(url.includes('completions'), false);
  }
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('endpoint'), false);
});

test('discovery degrades failed show safely and removes providers absent on next discovery', async () => {
  let offline = false;
  const local = new LocalProviders({ cliDetector: async () => [], discoveryTimeoutMs: 15,
    transport: transport(async (url) => {
      if (offline) throw new Error('secret');
      if (url === PROVIDERS.ollama.list) return json({ models: [{ name: 'writer' }] });
      if (url === PROVIDERS.lmstudio.list) return new Response(null, { status: 307 });
      return new Promise(() => {});
    }),
  });
  assert.deepEqual((await local.discover()).providers, [{ id: 'ollama', models: [{ id: 'writer', label: 'writer', tools: false }] }]);
  offline = true;
  assert.deepEqual(await local.discover(), { providers: [], detectedClis: [] });
});

test('PATH detection checks executable regular files/symlink targets without executing or reading config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-path-'));
  try {
    const marker = join(directory, 'EXECUTED');
    await writeFile(join(directory, 'codex'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    await writeFile(join(directory, 'claude'), '# private login data\n', { mode: 0o600 });
    await mkdir(join(directory, 'copilot'));
    assert.deepEqual(await detectClis({ path: `${directory}${delimiter}.`, platform: 'darwin' }), ['codex']);
    await chmod(join(directory, 'claude'), 0o700);
    await rm(join(directory, 'copilot'), { recursive: true });
    await symlink(join(directory, 'codex'), join(directory, 'copilot'));
    assert.deepEqual(await detectClis({ path: directory, platform: 'darwin' }), ['claude', 'codex', 'copilot']);
    const { stat } = await import('node:fs/promises');
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
