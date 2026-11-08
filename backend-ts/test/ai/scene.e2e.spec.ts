import type { INestApplication } from '@nestjs/common';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { recordLlmFailure, type LlmCallOptions, type LlmResult } from '../../src/ai/llm/llm-client.interface';
import { buildTestApp, llmCalls, registerUser } from '../utils/app';
import { closeTestDb, query, truncateAll } from '../utils/db';

const PLAN_PATH = '/api/ai/scene/plan/stream';
const WRITE_PATH = '/api/ai/scene/stream';
const plan = { goal: '沈川取到钥匙', withheld: '不得揭露沈川是王子', pov: '沈川有限视角', ending: '停在开门前', targetChars: 800 };
const draft = '雨落在屋檐下。沈川知道守卫正在想他的身世。门仍紧闭。';
const quote = '沈川知道守卫正在想他的身世';
const issue = { kind: 'pov', constraintId: 'pov', quote, reason: '沈川无法直接知道别人的想法', suggestion: '只写看得见的表情' };
const review = JSON.stringify({ findings: [issue] });
const repair = JSON.stringify({ edits: [{ id: 'finding-1', replacement: '沈川看见守卫欲言又止' }] });
let app: INestApplication;
let port: number;
let script: Array<LlmResult | Error> = [];
let disconnectMode = false;
let disconnectFinished: (() => void) | undefined;
let disconnectedSignal: AbortSignal | undefined;
let streamClosed = false;

function next(): LlmResult {
  const result = script.shift();
  if (!result) throw new Error('Unexpected additional scene LLM request');
  if (result instanceof Error) throw result;
  return result;
}
function frames(text: string): Array<{ type: string; data: any }> {
  return text.split('\n\n').filter(block => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map(block => JSON.parse(block.slice(6)));
}
function expectSuccess(response: request.Response) {
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('text/event-stream');
  expect(response.headers['x-accel-buffering']).toBe('no');
  const events = frames(response.text);
  expect(events.slice(-2).map(event => event.type)).toEqual(['result', 'done']);
  expect(response.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  return events;
}
function expectInBandFailure(response: request.Response) {
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('text/event-stream');
  const events = frames(response.text);
  expect(events.at(-1)?.type).toBe('error');
  expect(events.some(event => ['result', 'done'].includes(event.type))).toBe(false);
  expect(response.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  return events.at(-1)!.data.message as string;
}
async function fixture() {
  const { auth, user } = await registerUser(app, 'scene-owner@test.dev');
  const created = await request(app.getHttpServer()).post('/api/books').set(auth)
    .send({ title: '场景测试书', description: '城门、钥匙与一个秘密' });
  expect(created.status).toBe(201);
  const bookId = created.body.id as string;
  const chapter = await request(app.getHttpServer()).post(`/api/books/${bookId}/chapters`).set(auth).send({});
  expect(chapter.status).toBe(201);
  const chapterId = chapter.body.id as string;
  return { auth, user, bookId, chapterId,
    planning: { book_id: bookId, chapter_id: chapterId, content: '沈川站在门外。', intent: '沈川试探守卫并取得钥匙', model: 'scene-test-model' },
    writing: { book_id: bookId, chapter_id: chapterId, content: '沈川站在门外。', intent: '沈川试探守卫并取得钥匙', model: 'scene-test-model', plan, auto_repair: true },
  };
}

beforeAll(async () => {
  app = await buildTestApp({
    chat: async () => next(),
    streamEvents: async function* (options: LlmCallOptions) {
      if (disconnectMode) {
        disconnectedSignal = options.signal;
        try {
          yield { type: 'text', text: '断开前的正文' };
          await new Promise<never>((_resolve, reject) => {
            if (options.signal?.aborted) reject(options.signal.reason);
            else options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
          });
        } finally {
          streamClosed = true;
          disconnectFinished?.();
        }
        return;
      }
      const result = next();
      const middle = Math.ceil(result.answer.length / 2);
      yield { type: 'text', text: result.answer.slice(0, middle) };
      yield { type: 'text', text: result.answer.slice(middle) };
      yield { type: 'done', result };
    },
  });
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
});
afterAll(async () => {
  await app?.close();
  await closeTestDb();
});
beforeEach(async () => {
  await truncateAll();
  llmCalls.length = 0;
  script = [];
  disconnectMode = false;
  disconnectFinished = undefined;
  disconnectedSignal = undefined;
  streamClosed = false;
});

describe('scene HTTP authorization and strict input validation', () => {
  it.each([PLAN_PATH, WRITE_PATH])('%s requires authentication before accessing a book or LLM', async (path) => {
    const response = await request(app.getHttpServer()).post(path).send({});
    expect(response.status).toBe(403);
    expect(llmCalls).toHaveLength(0);
  });

  it.each([PLAN_PATH, WRITE_PATH])('%s rejects another author’s book before LLM generation', async (path) => {
    const f = await fixture();
    const intruder = await registerUser(app, 'scene-intruder@test.dev');
    const response = await request(app.getHttpServer()).post(path).set(intruder.auth)
      .send(path === PLAN_PATH ? f.planning : f.writing);
    expect(response.status).toBe(404);
    expect(response.body.detail).toBe('作品不存在');
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(llmCalls).toHaveLength(0);
  });

  it.each([PLAN_PATH, WRITE_PATH])('%s rejects foreign, missing, and malformed chapter IDs before LLM generation', async (path) => {
    const f = await fixture();
    const other = await request(app.getHttpServer()).post('/api/books').set(f.auth).send({ title: '同一作者另一本书' });
    const chapter = await request(app.getHttpServer()).post(`/api/books/${other.body.id}/chapters`).set(f.auth).send({});
    for (const chapter_id of [chapter.body.id, '00000000-0000-4000-8000-000000000001', 'not-a-uuid']) {
      const response = await request(app.getHttpServer()).post(path).set(f.auth)
        .send({ ...(path === PLAN_PATH ? f.planning : f.writing), chapter_id });
      expect(response.status).toBe(404);
      expect(response.body.detail).toBe('章节不存在');
      expect(llmCalls).toHaveLength(0);
    }
  });

  it.each([PLAN_PATH, WRITE_PATH])('%s rejects unknown fields, bad types and oversized request values', async (path) => {
    const f = await fixture();
    const base = path === PLAN_PATH ? f.planning : f.writing;
    for (const invalid of [
      { accountId: 'forged-owner' }, { extra: true }, { book_id: '' }, { content: 7 },
      { content: '甲'.repeat(60001) }, { intent: '  ' }, { intent: '甲'.repeat(1201) },
      { model: '' }, { model: 'a'.repeat(1601) }, { chapter_id: 2 },
    ]) {
      const response = await request(app.getHttpServer()).post(path).set(f.auth).send({ ...base, ...invalid });
      expect(response.status, JSON.stringify(Object.keys(invalid))).toBe(400);
      expect(llmCalls).toHaveLength(0);
    }
  });

  it('requires a complete strict confirmed plan and a boolean repair flag', async () => {
    const f = await fixture();
    const invalidPlans = [null, {}, { ...plan, extra: true }, { ...plan, targetChars: 199 },
      { ...plan, targetChars: 1601 }, { ...plan, targetChars: 800.5 }, { ...plan, goal: ' ' },
      { ...plan, goal: '甲'.repeat(601) }, { ...plan, withheld: '甲'.repeat(601) },
      { ...plan, pov: '甲'.repeat(301) }, { ...plan, ending: '甲'.repeat(401) }];
    for (const invalid of invalidPlans) {
      const response = await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send({ ...f.writing, plan: invalid });
      expect(response.status).toBe(400);
    }
    const response = await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send({ ...f.writing, auto_repair: 'true' });
    expect(response.status).toBe(400);
    expect(llmCalls).toHaveLength(0);
  });
});

describe('scene HTTP SSE complete workflows', () => {
  it('streams context/plan stages then a structured editable plan with metrics and owner-routed no-tools request', async () => {
    const f = await fixture();
    script = [{ answer: JSON.stringify(plan), finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 20 } }];
    const response = await request(app.getHttpServer()).post(PLAN_PATH).set(f.auth).send(f.planning);
    const events = expectSuccess(response);
    expect(events.map(e => e.type)).toEqual(['stage', 'stage', 'result', 'done']);
    expect(events.slice(0, 2).map(e => e.data.stage)).toEqual(['context', 'plan']);
    expect(events[2].data).toMatchObject({ plan, metrics: { requestCount: 1, attemptCount: 1,
      usage: { status: 'complete', knownInputTokens: 40, knownOutputTokens: 20 } } });
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({ model: f.planning.model, accountId: f.user.id, maxTokens: 1800 });
    expect(llmCalls[0].tools).toBeUndefined();
  });

  it('streams draft tokens, reviews, repairs once, and returns applicable prose without saving the chapter', async () => {
    const f = await fixture();
    await request(app.getHttpServer()).put('/api/chapters/save').set(f.auth)
      .send({ chapter_id: f.chapterId, content: f.writing.content, title: null });
    await request(app.getHttpServer()).post(`/api/books/${f.bookId}/characters`).set(f.auth)
      .send({ name: '沈川', role: '主角', bio: '不会游泳' });
    script = [
      { answer: draft, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 4 } },
      { answer: review, finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 6 } },
      { answer: repair, finishReason: 'stop', usage: { inputTokens: 30, outputTokens: 8 } },
    ];
    const response = await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send(f.writing);
    const events = expectSuccess(response);
    expect(events.map(e => e.type)).toEqual(['stage', 'stage', 'token', 'token', 'stage', 'stage', 'result', 'done']);
    expect(events.filter(e => e.type === 'stage').map(e => e.data.stage)).toEqual(['context', 'draft', 'review', 'repair']);
    expect(events.filter(e => e.type === 'token').map(e => e.data.text).join('')).toBe(draft);
    const result = events.find(e => e.type === 'result')!.data;
    expect(result).toMatchObject({ plan, draft, revised: draft.replace(quote, '沈川看见守卫欲言又止'), repairApplied: true,
      findings: [{ id: 'finding-1', quote, severity: 'conflict', constraint: plan.pov, repairable: true }],
      metrics: { requestCount: 3, attemptCount: 3, usage: { status: 'complete', knownInputTokens: 60, knownOutputTokens: 18 } } });
    expect(result.warnings.join('')).toContain('未再次调用模型审阅');
    expect(llmCalls).toHaveLength(3);
    for (const call of llmCalls) {
      expect(call).toMatchObject({ model: f.writing.model, accountId: f.user.id });
      expect(call.tools).toBeUndefined();
      const prompt = call.messages.map(m => m.content).join('\n');
      for (const value of [plan.goal, plan.withheld, plan.pov, plan.ending]) expect(prompt).toContain(value);
    }
    expect(llmCalls[0].messages.map(m => m.content).join('\n')).toContain('不会游泳');
    const saved = await request(app.getHttpServer()).get(`/api/chapters/${f.chapterId}`).set(f.auth);
    expect(saved.body.content).toBe(f.writing.content);
    expect(await query('SELECT id FROM agent_proposals')).toEqual([]);
  });

  it('defaults auto_repair to false, accepts absent chapter/model, and makes only draft/review requests', async () => {
    const f = await fixture();
    script = [{ answer: draft, finishReason: 'stop' }, { answer: review, finishReason: 'stop' }];
    const { auto_repair, chapter_id, model, ...body } = f.writing;
    const response = await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send(body);
    const events = expectSuccess(response);
    expect(events.find(e => e.type === 'result')!.data).toMatchObject({ draft, revised: draft, repairApplied: false });
    expect(llmCalls).toHaveLength(2);
    expect(events.filter(e => e.type === 'stage').map(e => e.data.stage)).toEqual(['context', 'draft', 'review']);
  });

  it('drops fabricated evidence with a warning and never makes a repair request', async () => {
    const f = await fixture();
    script = [{ answer: draft }, { answer: JSON.stringify({ findings: [{ ...issue, quote: '原文没有的证据' }] }) }];
    const events = expectSuccess(await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send(f.writing));
    expect(events.find(e => e.type === 'result')!.data).toMatchObject({ findings: [], repairApplied: false, revised: draft });
    expect(events.find(e => e.type === 'result')!.data.warnings.join('')).toContain('1 条意见');
    expect(llmCalls).toHaveLength(2);
  });

  it('includes failed repair retries/known usage while preserving the reviewed draft', async () => {
    const f = await fixture();
    const failure = new Error('repair provider failed');
    recordLlmFailure(failure, [{ durationMs: 1, status: 'failed' },
      { durationMs: 2, status: 'failed', usage: { inputTokens: 7, outputTokens: 1 } }]);
    script = [{ answer: draft, usage: { inputTokens: 10, outputTokens: 4 } },
      { answer: review, usage: { inputTokens: 20, outputTokens: 6 } }, failure];
    const events = expectSuccess(await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send(f.writing));
    const result = events.find(e => e.type === 'result')!.data;
    expect(result).toMatchObject({ draft, revised: draft, repairApplied: false, metrics: { requestCount: 3, attemptCount: 4,
      usage: { status: 'partial', knownInputTokens: 37, knownOutputTokens: 11 } } });
    expect(result.warnings.join('')).toContain('已保留审阅过的初稿');
    expect(llmCalls).toHaveLength(3);
  });

  it('carries explicit author constraints into ordinary /ai/write continuation prompts', async () => {
    const f = await fixture();
    const instruction = '沈川必须拿到钥匙；不得揭露身世；只使用沈川有限视角；停在城门打开前。';
    script = [{ answer: '沈川接住了钥匙。', finishReason: 'stop' }];
    const response = await request(app.getHttpServer()).post('/api/ai/write').set(f.auth)
      .send({ book_id: f.bookId, chapter_id: f.chapterId, command: 'continue', content: f.writing.content, instruction });
    expect(response.status).toBe(200);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].messages.map(m => m.content).join('\n')).toContain(instruction);
  });
});

describe('scene HTTP failure and cancellation boundaries', () => {
  it.each(['{malformed', '{}', JSON.stringify({ ...plan, extra: true })])('returns an in-band planning error without an applicable result: %s', async (answer) => {
    const f = await fixture();
    script = [{ answer }];
    const response = await request(app.getHttpServer()).post(PLAN_PATH).set(f.auth).send(f.planning);
    expect(expectInBandFailure(response)).toContain('未生成可应用结果');
    expect(llmCalls).toHaveLength(1);
  });

  it.each(['{malformed', '{}', '{"findings":[{}]}'])('never returns applicable prose when review is malformed/incomplete: %s', async (answer) => {
    const f = await fixture();
    script = [{ answer: draft }, { answer }];
    const response = await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send(f.writing);
    expect(expectInBandFailure(response)).toContain('未生成可应用结果');
    expect(frames(response.text).filter(e => e.type === 'token').map(e => e.data.text).join('')).toBe(draft);
    expect(llmCalls).toHaveLength(2);
  });

  it.each(['plan', 'draft', 'review'])('rejects length-truncated %s output, including streamed terminal events', async (stage) => {
    const f = await fixture();
    script = stage === 'plan' ? [{ answer: JSON.stringify(plan), finishReason: 'length' }]
      : stage === 'draft' ? [{ answer: draft, finishReason: 'length' }]
        : [{ answer: draft, finishReason: 'stop' }, { answer: review, finishReason: 'length' }];
    const response = await request(app.getHttpServer()).post(stage === 'plan' ? PLAN_PATH : WRITE_PATH)
      .set(f.auth).send(stage === 'plan' ? f.planning : f.writing);
    expect(expectInBandFailure(response)).toContain('长度上限');
    expect(llmCalls).toHaveLength(stage === 'review' ? 2 : 1);
  });

  it('returns no applicable result after a review provider failure', async () => {
    const f = await fixture();
    script = [{ answer: draft }, new Error('review unavailable')];
    const response = await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send(f.writing);
    expect(expectInBandFailure(response)).toContain('review unavailable');
    expect(llmCalls).toHaveLength(2);
  });

  it('keeps the reviewed draft when streamed output is complete but repair is truncated', async () => {
    const f = await fixture();
    script = [{ answer: draft, finishReason: 'stop' }, { answer: review, finishReason: 'stop' },
      { answer: repair, finishReason: 'length' }];
    const events = expectSuccess(await request(app.getHttpServer()).post(WRITE_PATH).set(f.auth).send(f.writing));
    expect(events.find(e => e.type === 'result')!.data).toMatchObject({ draft, revised: draft, repairApplied: false });
    expect(llmCalls).toHaveLength(3);
  });

  it('aborts the real upstream stream when a socket disconnects after a draft token, without starting review', async () => {
    const f = await fixture();
    disconnectMode = true;
    const stopped = new Promise<void>(resolve => { disconnectFinished = resolve; });
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify(f.writing);
      const req = http.request({ host: '127.0.0.1', port, path: WRITE_PATH, method: 'POST',
        headers: { ...f.auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        let received = '';
        res.on('data', chunk => {
          received += chunk.toString();
          if (received.includes('断开前的正文')) {
            res.destroy();
            req.destroy();
            resolve();
          }
        });
        res.on('error', () => undefined);
        res.on('end', () => reject(new Error(`Stream ended before disconnect token: ${received}`)));
      });
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('Timed out waiting for draft token')); });
      req.on('error', error => { if (!req.destroyed) reject(error); });
      req.end(body);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([stopped, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Disconnect did not cancel upstream generation')), 3000);
      })]);
    } finally { clearTimeout(timeout); }
    expect(streamClosed).toBe(true);
    expect(disconnectedSignal?.aborted).toBe(true);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].signal?.aborted).toBe(true);
  });
});
