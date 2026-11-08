#!/usr/bin/env node
// Explicitly invoked real-model evaluation. --dry-run never sends a network request.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cases = JSON.parse(await readFile(fileURLToPath(new URL('../eval/scenes/cases.json', import.meta.url)), 'utf8'));
const selected = option('--case') ? cases.filter(c => c.id === option('--case')) : cases;
if (!selected.length) throw new Error('Unknown case');
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ syntheticCases: selected.map(c => c.id),
    callsPerCase: { baseline: '1..5 (existing Agent may use tools)', scene: '2..3 (generation, review, optional one repair)' },
    planning: 'Predefined author-approved goals; planning cost excluded', networkRequests: 0 }, null, 2));
  process.exit(0);
}
const root = option('--api');
const bookId = option('--book');
const model = option('--model');
const output = option('--out');
const token = process.env.SCENE_EVAL_TOKEN;
if (!root || !bookId || !model || !output || !token || !args.includes('--execute')) {
  console.error('Usage: SCENE_EVAL_TOKEN=... node tools/evaluate-scenes.mjs --execute --api API_ROOT --book EMPTY_TEST_BOOK_ID --model MODEL_ID --out NEW_DIRECTORY [--case ID]\nUse --dry-run to inspect without requests. Real execution consumes provider quota.');
  process.exit(1);
}
const url = new URL(root);
if (url.username || url.password || url.search || url.hash ||
  (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
  throw new Error('API root must be HTTPS or an explicit loopback HTTP URL');
}
const base = root.replace(/\/$/, '');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
// Require an empty isolated book: prior stored material would invalidate fixture comparisons.
const bookResponse = await fetch(`${base}/books/${encodeURIComponent(bookId)}`, { headers, redirect: 'error' });
if (!bookResponse.ok) throw new Error(`Test book lookup failed (${bookResponse.status})`);
const book = await bookResponse.json();
if (['chapters', 'characters', 'outlines', 'inspirations'].some(key => !Array.isArray(book[key]) || book[key].length)) {
  throw new Error('Use an empty test book with no chapters, characters, outlines or inspirations');
}
const directory = resolve(output);
await mkdir(directory, { recursive: false }); // Refuse to overwrite an existing measurement.
const results = [];
const blind = [];
const save = async () => {
  await writeFile(resolve(directory, 'results.json'), JSON.stringify({ model,
    note: 'Synthetic cases, same model and author constraints. Retrieval/prompt/orchestration differ. Scene includes review and optional repair. No planning call. Unknown usage is not zero cost.',
    results }, null, 2));
  await writeFile(resolve(directory, 'blind-review.json'), JSON.stringify(blind, null, 2));
};
async function ordinary(body) {
  const start = performance.now();
  const response = await fetch(`${base}/ai/write`, { method: 'POST', headers, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw new Error(`Baseline request failed (${response.status})`);
  const data = await response.json();
  if (typeof data.data?.answer !== 'string' || !data.data.answer.trim()) throw new Error('Empty baseline');
  return { text: data.data.answer, durationMs: performance.now() - start, requestCount: null, usage: 'unknown (ordinary API does not return metrics)' };
}
async function scene(body) {
  const start = performance.now();
  const response = await fetch(`${base}/ai/scene/stream`, { method: 'POST', headers, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw new Error(`Scene request failed (${response.status})`);
  const text = await response.text();
  let result; let done = false; let sentinel = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') { sentinel = true; continue; }
    const event = JSON.parse(payload);
    if (event.type === 'error') throw new Error('Scene task failed; no usable evaluation sample');
    if (event.type === 'result') result = event.data;
    if (event.type === 'done') done = true;
  }
  if (!done || !sentinel || typeof result?.revised !== 'string') throw new Error('Incomplete scene stream');
  return { ...result, text: result.revised, durationMs: performance.now() - start };
}
for (const item of selected) {
  // Randomize execution order to reduce systematic warmup effects.
  const order = randomInt(2) ? ['baseline', 'scene'] : ['scene', 'baseline'];
  const measured = {};
  try {
    for (const variant of order) {
      measured[variant] = variant === 'baseline'
        ? await ordinary({ book_id: bookId, content: item.content, command: 'continue', model,
          instruction: `${item.intent}\n作者场景目标：${JSON.stringify(item.plan)}` })
        : await scene({ book_id: bookId, content: item.content, intent: item.intent, plan: item.plan, model, auto_repair: true });
    }
    const labels = randomInt(2) ? ['baseline', 'scene'] : ['scene', 'baseline'];
    results.push({ id: item.id, order, labelMap: { A: labels[0], B: labels[1] }, measured });
    blind.push({ id: item.id, content: item.content, intent: item.intent, plan: item.plan, checks: item.checks,
      samples: labels.map((variant, i) => ({ label: i === 0 ? 'A' : 'B', text: measured[variant].text,
        grade: { goalScore0to2: null, forbiddenReveal: null, povViolation: null, continuityConflict: null,
          authorEditedCharacters: null, notes: '' } })), preferred: null });
    await save();
    console.log(`Recorded ${item.id}`);
  } catch {
    results.push({ id: item.id, order, measured, failed: true });
    await save();
    console.error(`Stopped at ${item.id}: request failed. Partial measurements saved; no quality score assigned.`);
    process.exitCode = 1;
    break;
  }
}
