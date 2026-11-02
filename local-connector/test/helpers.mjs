import { LocalProviders } from '../src/discovery.mjs';
import { HttpTransport } from '../src/http.mjs';

export const ID = '12345678-1234-1234-1234-123456789abc';
export const ID2 = '12345678-1234-1234-1234-123456789abd';
export const TOKEN = `${ID}.${'a'.repeat(64)}`;
export const CODE = 'b'.repeat(64);
export const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
export const completion = (answer = '本机正文') => chunk({ content: answer }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
export const job = (overrides = {}) => ({ id: ID, provider: 'ollama', model: 'writer:latest', messages: [{ role: 'user', content: '继续写作' }], maxTokens: 512, temperature: 0.7, ...overrides });
export const inventory = (tools = true) => ({ providers: [
  { id: 'ollama', models: [{ id: 'writer:latest', label: 'writer:latest', tools }] },
  { id: 'lmstudio', models: [{ id: 'local-writer', label: 'local-writer', tools: false }] },
], detectedClis: [] });
export function providers(fetchImpl, options = {}) {
  const result = new LocalProviders({ transport: new HttpTransport({ fetchImpl }), cliDetector: async () => [], ...options });
  result.inventory = inventory();
  return result;
}
export async function collect(iterable) { const result = []; for await (const item of iterable) result.push(item); return result; }
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function bounded(promise, ms = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
}
