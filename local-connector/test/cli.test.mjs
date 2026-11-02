import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseArgs } from '../src/cli.mjs';
import { deferred, bounded } from './helpers.mjs';

function harness() {
  const input = new PassThrough(), signals = new EventEmitter();
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  return { input, signals, output, text: () => text };
}

test('arguments exclude pairing codes/commands and validate name and API root', () => {
  assert.deepEqual(parseArgs(['--api-root', 'https://site.example/api'], {}), { apiRoot: 'https://site.example/api', name: '我的电脑', help: false });
  assert.equal(parseArgs([], { AI_WRITING_API_ROOT: 'https://site.example/api' }).apiRoot, 'https://site.example/api');
  assert.equal(parseArgs(['--server', 'http://localhost:8001/api'], {}).apiRoot, 'http://localhost:8001/api');
  assert.throws(() => parseArgs(['--server', 'https://site.example/api', '--api-root', 'https://other.example/api'], {}));
  for (const args of [['--code', 'SECRET'], ['--exec', 'codex'], ['--api-root'], ['--help', '--code', 'SECRET'], ['--api-root', 'https://site/api', '--name', '\u001b[1m']]) assert.throws(() => parseArgs(args, {}));
});

test('interactive pairing, stdin EOF and both signals abort runtime and remove listeners', async () => {
  for (const ending of ['EOF', 'SIGINT', 'SIGTERM']) {
    const h = harness(), entered = deferred();
    let received, requestSignal;
    const pending = main({ ...h, args: ['--api-root', 'https://site.example/api'], env: {},
      providersFactory: () => ({}), cloudFactory: () => ({}), runtimeFactory: () => ({ run: async (options) => {
        received = options; requestSignal = options.signal; entered.resolve();
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      } }),
    });
    h.input.write('PRIVATE_PAIR_CODE\n');
    await bounded(entered.promise);
    assert.equal(received.code, 'PRIVATE_PAIR_CODE');
    assert.equal(received.name, '我的电脑');
    if (ending === 'EOF') h.input.end(); else h.signals.emit(ending);
    assert.equal(await bounded(pending), 0);
    assert.equal(requestSignal.aborted, true);
    assert.equal(h.signals.listenerCount('SIGINT'), 0);
    assert.equal(h.signals.listenerCount('SIGTERM'), 0);
    assert.equal(h.input.listenerCount('error'), 0);
    assert.equal(h.text().includes('PRIVATE_PAIR_CODE'), false);
    assert.match(h.text(), /作品上下文/);
  }
});

test('environment keys go only to local providers; raw startup errors and code never reach output', async () => {
  const h = harness();
  let localOptions, cloudOptions, received;
  const exit = await main({ ...h, args: ['--api-root', 'https://site.example/api'],
    env: { AI_WRITING_PAIR_CODE: 'PAIR_PRIVATE', AI_WRITING_OLLAMA_API_KEY: 'OLLAMA_PRIVATE', AI_WRITING_LMSTUDIO_API_KEY: 'STUDIO_PRIVATE' },
    providersFactory: (options) => { localOptions = options; return {}; },
    cloudFactory: (options) => { cloudOptions = options; return {}; },
    runtimeFactory: () => ({ run: async (options) => { received = options; throw new Error('PRIVATE_UPSTREAM_BODY'); } }),
  });
  assert.equal(exit, 1);
  assert.deepEqual(localOptions, { ollamaKey: 'OLLAMA_PRIVATE', lmstudioKey: 'STUDIO_PRIVATE' });
  assert.deepEqual(cloudOptions, { apiRoot: 'https://site.example/api' });
  assert.equal(received.code, 'PAIR_PRIVATE');
  assert.equal(h.text().includes('PRIVATE'), false);
});

test('EOF while waiting for code exits without pairing', async () => {
  const h = harness();
  const pending = main({ ...h, args: ['--api-root', 'https://site.example/api'], env: {}, providersFactory: () => { assert.fail('must not pair'); } });
  h.input.end();
  assert.equal(await bounded(pending), 0);
});

test('actual CLI --help is bounded, works without env/dependencies, and invalid arguments redact secrets', async () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  for (const args of [['--help'], ['--code', 'DO_NOT_PRINT_SECRET']]) {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (data) => { text += data; });
    child.stderr.on('data', (data) => { text += data; });
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    try {
      const code = await bounded(ended);
      assert.equal(code, args[0] === '--help' ? 0 : 1);
      assert.equal(text.includes('DO_NOT_PRINT_SECRET'), false);
      assert.ok(text.length > 0);
    } finally { if (child.exitCode === null) child.kill(); }
  }
});
