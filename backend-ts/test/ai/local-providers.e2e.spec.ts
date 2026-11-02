import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { SiliconFlowClient } from '../../src/ai/llm/silicon-flow.client';
import { AllExceptionsFilter } from '../../src/core/http-exception.filter';
import { LocalProvidersService, LOCAL_PAIR_TTL_MS } from '../../src/local-providers/local-providers.service';
import { LocalJobBroker, type LocalJob } from '../../src/local-providers/local-job-broker';
import { localModelKey } from '../../src/local-providers/protocol';
import { registerUser } from '../utils/app';
import { closeTestDb, query, truncateAll } from '../utils/db';

let app: INestApplication;
let owner: Awaited<ReturnType<typeof registerUser>>;
let other: Awaited<ReturnType<typeof registerUser>>;
let bookId: string;
const cloud = { chat: vi.fn(), chatStream: vi.fn(), streamEvents: vi.fn(), embed: vi.fn(async () => []) };
const inventory = { providers: [{ id: 'ollama', models: [{ id: 'test/model:1', label: '测试模型', tools: true, contextWindow: 32768 }] }], detectedClis: ['codex'] };
const http = () => request(app.getHttpServer());
const runtime = (token: string) => ({ Authorization: `Bearer ${token}` });
const code = async () => (await http().post('/api/local-providers/pairing').set(owner.auth).send({}).expect(200)).body.code as string;
async function pair(enable = false, data = inventory) {
  const response = await http().post('/api/local-runtime/pair').send({ version: 1, code: await code(), name: '我的电脑', inventory: data }).expect(200);
  if (enable) await http().put(`/api/local-providers/connections/${response.body.connectionId}`).set(owner.auth).send({ enabled: true }).expect(200);
  return response.body as { connectionId: string; token: string };
}
async function pollUntilJob(token: string): Promise<LocalJob> {
  for (let n = 0; n < 100; n++) {
    const response = await http().post('/api/local-runtime/poll').set(runtime(token)).send({}).expect(200);
    if (response.body.job) return response.body.job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('No local job dispatched');
}
const sendEvent = (token: string, id: string, seq: number, event: unknown) => http()
  .post(`/api/local-runtime/jobs/${id}/events`).set(runtime(token)).send({ seq, event });
const write = (model: string, auth = owner.auth, extra = {}) => http().post('/api/ai/write').set(auth)
  .send({ book_id: bookId, command: 'continue', content: '月色落在剑上。', model, ...extra });

beforeAll(async () => {
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SiliconFlowClient).useValue(cloud).compile();
  app = ref.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
});
beforeEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); await truncateAll();
  owner = await registerUser(app, 'local-owner@test.dev'); other = await registerUser(app, 'local-other@test.dev');
  bookId = (await http().post('/api/books').set(owner.auth).send({ title: '本机作品' }).expect(201)).body.id;
});
afterAll(async () => { vi.restoreAllMocks(); await app?.close(); await closeTestDb(); });

describe('本机连接认证与配对', () => {
  it('必须登录；配对码单次使用，连接初始禁用且不泄漏令牌/哈希', async () => {
    await http().post('/api/local-providers/pairing').send({}).expect(403);
    const value = await code();
    const body = { version: 1, code: value, name: '我的电脑', inventory };
    const results = await Promise.all([http().post('/api/local-runtime/pair').send(body), http().post('/api/local-runtime/pair').send(body)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    const list = (await http().get('/api/local-providers').set(owner.auth).expect(200)).body;
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]).toMatchObject({ enabled: false, online: true, detectedClis: ['codex'] });
    expect(JSON.stringify(list)).not.toMatch(/token|Hash|ownerId|secret|endpoint/);
    expect((await http().get('/api/local-providers').set(other.auth).expect(200)).body.connections).toEqual([]);
  });
  it('新配对码作废旧码，过期码不能配对', async () => {
    const old = await code(); const current = await code();
    await http().post('/api/local-runtime/pair').send({ version: 1, code: old, name: '电脑', inventory }).expect(400);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + LOCAL_PAIR_TTL_MS + 1000);
    await http().post('/api/local-runtime/pair').send({ version: 1, code: current, name: '电脑', inventory }).expect(400);
  });
  it('每账号最多五台设备', async () => {
    for (let n = 0; n < 5; n++) await pair();
    await http().post('/api/local-runtime/pair').send({ version: 1, code: await code(), name: '第六台', inventory }).expect(409);
  });
  it('runtime令牌与账号JWT权限隔离，畸形UUID返回401', async () => {
    const c = await pair();
    await http().get('/api/local-providers').set(runtime(c.token)).expect(401);
    await http().post('/api/local-runtime/poll').set(owner.auth).send({}).expect(401);
    await http().post('/api/local-runtime/poll').set(runtime(`${'-'.repeat(36)}.${'a'.repeat(64)}`)).send({}).expect(401);
    await http().post('/api/ai/proposals/00000000-0000-4000-8000-000000000001/confirm').set(runtime(c.token)).send({ digest: 'a'.repeat(64) }).expect(401);
  });
  it('跨账号不能修改或撤销连接，撤销立即使runtime令牌失效', async () => {
    const c = await pair();
    await http().put(`/api/local-providers/connections/${c.connectionId}`).set(other.auth).send({ enabled: true }).expect(404);
    await http().delete(`/api/local-providers/connections/${c.connectionId}`).set(other.auth).expect(404);
    await http().delete(`/api/local-providers/connections/${c.connectionId}`).set(owner.auth).expect(204);
    await http().post('/api/local-runtime/poll').set(runtime(c.token)).send({}).expect(401);
  });
  it('拒绝任意endpoint、重复模型、额外密钥和超量模型', async () => {
    const value = await code();
    for (const invalid of [
      { ...inventory, endpoint: 'http://10.0.0.1' },
      { ...inventory, providers: [{ ...inventory.providers[0], models: Array(21).fill(inventory.providers[0].models[0]) }] },
      { ...inventory, providers: [{ ...inventory.providers[0], models: Array(2).fill(inventory.providers[0].models[0]) }] },
      { ...inventory, apiKey: 'must-stay-local' },
    ]) await http().post('/api/local-runtime/pair').send({ version: 1, code: value, name: '电脑', inventory: invalid }).expect(400);
  });
});

describe('本机模型实际HTTP生成', () => {
  it('写作通过受限任务往返，完整正文返回，accountId不进入本机任务', async () => {
    const c = await pair(true); const model = localModelKey(c.connectionId, 'ollama', 'test/model:1');
    const pending = write(model).then(r => r);
    const job = await pollUntilJob(c.token);
    expect(job).toMatchObject({ provider: 'ollama', model: 'test/model:1' });
    expect(JSON.stringify(job)).not.toContain(owner.user.id);
    expect(job.messages.some(m => m.content.includes('月色落在剑上。'))).toBe(true);
    await sendEvent(c.token, job.id, 1, { type: 'text', text: '风吹动树梢。' }).expect(200);
    const terminal = { type: 'done', result: { answer: '风吹动树梢。', finishReason: 'stop' } };
    await sendEvent(c.token, job.id, 2, terminal).expect(200);
    const response = await pending;
    expect(response.status).toBe(200); expect(JSON.stringify(response.body)).toContain('风吹动树梢。');
    await sendEvent(c.token, job.id, 2, terminal).expect(200);
    expect(cloud.chat).not.toHaveBeenCalled(); expect(cloud.streamEvents).not.toHaveBeenCalled();
  });
  it('本机Agent工具仍在服务器执行，第二轮携带工具结果', async () => {
    const c = await pair(true); const model = localModelKey(c.connectionId, 'ollama', 'test/model:1');
    const pending = http().post('/api/ai/agent').set(owner.auth).send({ book_id: bookId, message: '看看章节', model }).then(r => r);
    const job = await pollUntilJob(c.token);
    expect(job.tools?.some(t => t.name === 'list_chapters')).toBe(true);
    await sendEvent(c.token, job.id, 1, { type: 'done', result: { answer: '', finishReason: 'tool_calls',
      toolCalls: [{ id: 'local-call', name: 'list_chapters', argumentsJson: '{}' }] } }).expect(200);
    const next = await pollUntilJob(c.token);
    expect(next.messages.some(m => m.role === 'tool' && m.toolCallId === 'local-call')).toBe(true);
    await sendEvent(c.token, next.id, 1, { type: 'text', text: '还没有章节。' }).expect(200);
    await sendEvent(c.token, next.id, 2, { type: 'done', result: { answer: '还没有章节。', finishReason: 'stop' } }).expect(200);
    expect((await pending).status).toBe(200);
  });
  it('未验证工具能力的模型不下发工具schema', async () => {
    const c = await pair(true, { ...inventory, providers: [{ ...inventory.providers[0], models: [{ ...inventory.providers[0].models[0], tools: false }] }] });
    const pending = http().post('/api/ai/agent').set(owner.auth).send({ book_id: bookId, message: '写一段故事',
      model: localModelKey(c.connectionId, 'ollama', 'test/model:1') }).then(r => r);
    const job = await pollUntilJob(c.token); expect(job.tools).toBeUndefined();
    await sendEvent(c.token, job.id, 1, { type: 'done', result: { answer: '', finishReason: 'stop' } }).expect(200);
    expect((await pending).status).toBe(200);
  });
  it('小窗口限制输出预算；受保护任务超额时不创建本机任务', async () => {
    const c = await pair(true, { ...inventory, providers: [{ ...inventory.providers[0], models: [{ ...inventory.providers[0].models[0], tools: false, contextWindow: 8192 }] }] });
    const model = localModelKey(c.connectionId, 'ollama', 'test/model:1');
    const pending = http().post('/api/ai/agent').set(owner.auth).send({ book_id: bookId, message: '写一句话', model }).then(r => r);
    const job = await pollUntilJob(c.token); expect(job.maxTokens).toBe(2048);
    await sendEvent(c.token, job.id, 1, { type: 'done', result: { answer: '', finishReason: 'stop' } }).expect(200);
    expect((await pending).status).toBe(200);
    const rejected = await http().post('/api/ai/agent').set(owner.auth).send({ book_id: bookId, message: '文'.repeat(2000), model });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect((await http().post('/api/local-runtime/poll').set(runtime(c.token)).send({}).expect(200)).body.job).toBeNull();
    expect(cloud.chat).not.toHaveBeenCalled();
  });
  it('真实SSE客户端断开取消本机任务，迟到结果被拒绝', async () => {
    const c = await pair(true); const abort = new AbortController();
    const response = await fetch(`${await app.getUrl()}/api/ai/agent/stream`, { method: 'POST',
      headers: { ...owner.auth, 'Content-Type': 'application/json' }, signal: abort.signal,
      body: JSON.stringify({ book_id: bookId, message: '慢速任务', model: localModelKey(c.connectionId, 'ollama', 'test/model:1') }) });
    expect(response.status).toBe(200);
    const job = await pollUntilJob(c.token);
    abort.abort(); await response.body?.cancel().catch(() => {});
    await vi.waitFor(async () => {
      const state = await http().get(`/api/local-runtime/jobs/${job.id}/status`).set(runtime(c.token)).expect(200);
      expect(state.body.status).toBe('cancelled');
    });
    await sendEvent(c.token, job.id, 1, { type: 'text', text: '迟到结果' }).expect(409);
  });
  it('停用、离线、跨账号及畸形模型不可使用且不回退云端', async () => {
    const c = await pair(); const model = localModelKey(c.connectionId, 'ollama', 'test/model:1');
    expect((await write(model)).status).toBeGreaterThanOrEqual(400);
    await http().put(`/api/local-providers/connections/${c.connectionId}`).set(owner.auth).send({ enabled: true }).expect(200);
    await query('UPDATE local_model_connections SET last_seen_at = now() - interval \'1 minute\' WHERE id=$1', [c.connectionId]);
    expect((await write(model)).status).toBeGreaterThanOrEqual(400);
    await http().post('/api/local-runtime/poll').set(runtime(c.token)).send({}).expect(200);
    const otherBook = (await http().post('/api/books').set(other.auth).send({ title: '别人的书' }).expect(201)).body.id;
    const result = await http().post('/api/ai/write').set(other.auth).send({ book_id: otherBook, command: 'continue', content: '文字', model, accountId: owner.user.id });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect((await write(`local/${'-'.repeat(36)}/ollama/model`)).status).toBeGreaterThanOrEqual(400);
    expect(cloud.chat).not.toHaveBeenCalled(); expect(cloud.streamEvents).not.toHaveBeenCalled();
  });
  it('停用立即取消在途任务，其他连接不可读取或注入结果', async () => {
    const c = await pair(true); const second = await pair(true);
    const pending = write(localModelKey(c.connectionId, 'ollama', 'test/model:1')).then(r => r);
    const job = await pollUntilJob(c.token);
    await http().get(`/api/local-runtime/jobs/${job.id}/status`).set(runtime(second.token)).expect(404);
    await sendEvent(second.token, job.id, 1, { type: 'text', text: '越权' }).expect(404);
    await http().put(`/api/local-providers/connections/${c.connectionId}`).set(owner.auth).send({ enabled: false }).expect(200);
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    await sendEvent(c.token, job.id, 1, { type: 'text', text: '迟到' }).expect(409);
    expect(app.get(LocalJobBroker).take(c.connectionId)).toBeNull();
  });
});
