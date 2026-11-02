import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentProposalsModule } from '../../src/ai/agent/agent-proposals.module';
import {
  AGENT_PROPOSAL_TTL_MS, AgentProposalsService, type ProposalView,
} from '../../src/ai/agent/agent-proposals.service';
import { validateEnv } from '../../src/config/env';
import { AllExceptionsFilter } from '../../src/core/http-exception.filter';
import { DRIZZLE, type Database } from '../../src/db/drizzle.module';
import { agentProposals, books, characters, inspirations, schema, users, type Book } from '../../src/db/schema';
import { registerUser } from '../utils/app';
import { closeTestDb, query, truncateAll } from '../utils/db';

let app: INestApplication;
let db: Database;
let pool: Pool;
let service: AgentProposalsService;
let book: Book;
let owner: Awaited<ReturnType<typeof registerUser>>;
let intruder: Awaited<ReturnType<typeof registerUser>>;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });
  db = drizzle(pool, { schema });
  // 注册独立模块验证真实 Nest DI/认证/路由，不改 AiModule 或公共 test helper。
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv as never }), AgentProposalsModule],
  }).overrideProvider(DRIZZLE).useValue(db).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  service = app.get(AgentProposalsService);
});

beforeEach(async () => {
  await truncateAll();
  owner = await registerUser(app, 'proposal-owner@test.dev');
  intruder = await registerUser(app, 'proposal-intruder@test.dev');
  [book] = await db.insert(books).values({ title: '提案作品', ownerId: owner.user.id }).returning();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await pool?.end();
  await closeTestDb();
});

const createCharacter = (name = '林青') => service.create(book, 'save_character', { name, role: '主角', bio: '剑客' });
const createInspiration = () => service.createProposal(book, 'save_inspiration', { content: '月下古剑藏着一座城', tags: ['设定'] });
const confirm = (proposal: ProposalView, auth = owner.auth, body: unknown = { digest: proposal.digest }) =>
  request(app.getHttpServer()).post(`/api/ai/proposals/${proposal.id}/confirm`).set(auth).send(body);
const cancel = (proposal: ProposalView) => request(app.getHttpServer())
  .post(`/api/ai/proposals/${proposal.id}/cancel`).set(owner.auth).send({ digest: proposal.digest });

async function expectNoWrites() {
  expect(await db.select().from(characters)).toHaveLength(0);
  expect(await db.select().from(inspirations)).toHaveLength(0);
}

async function createExpired() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - AGENT_PROPOSAL_TTL_MS - 1000);
  try { return await createCharacter(); } finally { clock.mockRestore(); }
}

describe('Agent 提案：创建和边界校验', () => {
  it('创建结构化提案绑定真实 owner，20 分钟到期且不写人物/灵感', async () => {
    const start = Date.now();
    const proposal = await service.create(book, 'save_character', { name: ' 林青 ', bio: ' 剑客 ' });
    expect(proposal).toMatchObject({ bookId: book.id, tool: 'save_character', args: { name: '林青', role: '', bio: '剑客' }, status: 'pending' });
    expect(proposal.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(proposal.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(proposal.expiresAt) - start).toBeGreaterThanOrEqual(AGENT_PROPOSAL_TTL_MS);
    expect(Date.parse(proposal.expiresAt) - start).toBeLessThan(AGENT_PROPOSAL_TTL_MS + 5000);
    const [stored] = await db.select().from(agentProposals);
    expect(stored.ownerId).toBe(owner.user.id);
    expect(JSON.parse(stored.args)).toEqual(proposal.args);
    await expectNoWrites();
  });

  it('灵感默认标题按码点取前 20 字，空标签默认 []', async () => {
    const content = '𠮷'.repeat(21);
    const proposal = await service.create(book, 'save_inspiration', { content });
    expect(proposal.args).toEqual({ title: '𠮷'.repeat(20), content, tags: [] });
    await expectNoWrites();
  });

  it.each([
    ['delete_chapter', { id: randomUUID(), confirmed: true }],
    ['save_character', { name: '' }],
    ['save_character', { name: 1 }],
    ['save_character', { name: '甲', confirmed: true }],
    ['save_character', { name: '甲', bookId: randomUUID(), ownerId: randomUUID() }],
    ['save_character', { name: '甲', tool: 'delete_book', args: {} }],
    ['save_character', { name: '甲'.repeat(101) }],
    ['save_character', { name: '甲', role: '甲'.repeat(101) }],
    ['save_character', { name: '甲', bio: '甲'.repeat(501) }],
    ['save_character', { name: '甲\u0000乙' }],
    ['save_character', null],
    ['save_character', []],
    ['save_inspiration', { content: '  ' }],
    ['save_inspiration', { content: '甲'.repeat(2001) }],
    ['save_inspiration', { title: '甲'.repeat(201), content: '内容' }],
    ['save_inspiration', { content: '内容', tags: ['甲'.repeat(51)] }],
    ['save_inspiration', { content: '内容', tags: Array(21).fill('甲') }],
    ['save_inspiration', { content: '内容', tags: [1] }],
    ['save_inspiration', { content: '内容', tags: '设定' }],
  ])('拒绝工具/参数 %s %j', async (tool, args) => {
    await expect(service.create(book, tool, args)).rejects.toMatchObject({ status: 400 });
    expect(await db.select().from(agentProposals)).toHaveLength(0);
    await expectNoWrites();
  });

  it('接受码点长度上限，不在确认时静默截断用户看到的参数', async () => {
    const proposal = await service.create(book, 'save_character', {
      name: '𠮷'.repeat(100), role: '甲'.repeat(100), bio: '𠮷'.repeat(500),
    });
    const result = await confirm(proposal);
    expect(result.status).toBe(200);
    expect(result.body.result.character.bio).toBe('𠮷'.repeat(500));
  });

  it('伪造/过时 book.ownerId 或不存在书籍不能创建提案', async () => {
    await expect(service.create({ ...book, ownerId: intruder.user.id }, 'save_character', { name: '甲' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.create({ ...book, id: randomUUID() }, 'save_character', { name: '甲' }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('Agent 提案：JWT、所有权、摘要和状态', () => {
  it('确认需要 JWT：无 token 403，坏 token 401，已删除用户 token 401', async () => {
    const proposal = await createCharacter();
    expect((await confirm(proposal, {})).status).toBe(403);
    expect((await confirm(proposal, { Authorization: 'Bearer invalid' })).status).toBe(401);
    await db.delete(users).where(eq(users.id, owner.user.id));
    expect((await confirm(proposal)).status).toBe(401);
    await expectNoWrites();
  });

  it('别人即使知道 id 和 digest 也不能确认或取消；未知/非法 id 404', async () => {
    const proposal = await createCharacter();
    expect((await confirm(proposal, intruder.auth)).status).toBe(404);
    const rejected = await request(app.getHttpServer()).post(`/api/ai/proposals/${proposal.id}/cancel`)
      .set(intruder.auth).send({ digest: proposal.digest });
    expect(rejected.status).toBe(404);
    expect((await confirm({ ...proposal, id: randomUUID() })).status).toBe(404);
    expect((await confirm({ ...proposal, id: 'invalid' })).status).toBe(404);
    await expectNoWrites();
  });

  it('确认与取消都重新检查当前 book.ownerId，转移后的双方均不能确认旧提案', async () => {
    const proposal = await createCharacter();
    await db.update(books).set({ ownerId: intruder.user.id }).where(eq(books.id, book.id));
    expect((await confirm(proposal)).status).toBe(404);
    expect((await confirm(proposal, intruder.auth)).status).toBe(404);
    expect((await cancel(proposal)).status).toBe(404);
    await expectNoWrites();
  });

  it('拒绝摘要不匹配、缺失、confirmed:true 和恶意额外写字段', async () => {
    const proposal = await createCharacter();
    expect((await confirm(proposal, owner.auth, { digest: '0'.repeat(64) })).status).toBe(409);
    for (const body of [{}, { confirmed: true }, { digest: 'bad' }, { digest: proposal.digest, confirmed: true },
      { digest: proposal.digest, args: { name: '篡改' }, tool: 'delete_book', bookId: randomUUID() }]) {
      expect((await confirm(proposal, owner.auth, body)).status).toBe(400);
    }
    await expectNoWrites();
    expect((await db.select().from(agentProposals))[0].status).toBe('pending');
  });

  it('存储参数篡改后旧 digest 无法授权写入', async () => {
    const proposal = await createCharacter();
    await db.update(agentProposals).set({ args: JSON.stringify({ name: '被篡改', role: '', bio: '' }) })
      .where(eq(agentProposals.id, proposal.id));
    expect((await confirm(proposal)).status).toBe(409);
    await expectNoWrites();
  });

  it('首次确认过期提案 410，不改变状态或写库', async () => {
    const proposal = await createExpired();
    const res = await confirm(proposal);
    expect(res.status).toBe(410);
    expect(res.body.detail).toBe('提案已过期');
    expect((await cancel(proposal)).status).toBe(410);
    await expectNoWrites();
  });

  it('取消幂等、取消后确认 409，确认后取消 409', async () => {
    const proposal = await createCharacter();
    const first = await cancel(proposal);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('cancelled');
    expect((await cancel(proposal)).body).toEqual(first.body);
    expect((await confirm(proposal)).status).toBe(409);
    await expectNoWrites();
    const other = await createCharacter();
    expect((await confirm(other)).status).toBe(200);
    expect((await cancel(other)).status).toBe(409);
  });

  it('FK 级联删除：删书或删用户都清理提案', async () => {
    const first = await createCharacter();
    await db.delete(books).where(eq(books.id, book.id));
    expect(await db.select().from(agentProposals)).toHaveLength(0);
    expect((await confirm(first)).status).toBe(404);
    [book] = await db.insert(books).values({ title: '另一本书', ownerId: owner.user.id }).returning();
    await createInspiration();
    await db.delete(users).where(eq(users.id, owner.user.id));
    expect(await db.select().from(agentProposals)).toHaveLength(0);
  });
});

describe('Agent 提案：原子保存与并发幂等', () => {
  it.each(['character', 'inspiration'])('%s 重复/并发确认只保存一次，返回同一真实对象 id', async (kind) => {
    const proposal = await (kind === 'character' ? createCharacter() : createInspiration());
    const responses = await Promise.all(Array.from({ length: 6 }, () => confirm(proposal)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual(responses[0].body);
    }
    const rows = kind === 'character' ? await db.select().from(characters) : await db.select().from(inspirations);
    expect(rows).toHaveLength(1);
    expect(responses[0].body.result.id).toBe(rows[0].id);
    const [stored] = await db.select().from(agentProposals);
    expect(stored.status).toBe('confirmed');
    expect(JSON.parse(stored.result!)).toEqual(responses[0].body.result);
    expect((await confirm(proposal)).body).toEqual(responses[0].body);
    if (kind === 'inspiration') {
      expect(JSON.parse(responses[0].body.result.inspiration.tags)).toEqual(['设定']);
    }
  });

  it('不同提案并发创建同名人物，只创建一人，另一提案复用原对象', async () => {
    const proposals = await Promise.all([createCharacter(), createCharacter()]);
    const responses = await Promise.all(proposals.map((p) => confirm(p)));
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0].body.result.id).toBe(responses[1].body.result.id);
    expect(responses.map((r) => r.body.result.created).sort()).toEqual([false, true]);
    expect(await db.select().from(characters)).toHaveLength(1);
  });

  it('保留历史重名数据，复用既有人物并保留原 role/bio；不同书同名正常创建', async () => {
    const [existing] = await db.insert(characters).values({ bookId: book.id, name: '林青', role: '反派', bio: '原设定' }).returning();
    await db.insert(characters).values({ bookId: book.id, name: '林青', role: '另一个同名角色' });
    const res = await confirm(await createCharacter());
    expect(res.body.result).toMatchObject({ id: existing.id, created: false, character: { role: '反派', bio: '原设定' } });
    expect(await db.select().from(characters)).toHaveLength(2);
    const [otherBook] = await db.insert(books).values({ title: '另书', ownerId: owner.user.id }).returning();
    const other = await service.create(otherBook, 'save_character', { name: '林青' });
    expect((await confirm(other)).body.result.created).toBe(true);
    expect(await db.select().from(characters)).toHaveLength(3);
  });

  it('确认与取消并发只有一个最终状态，状态与实际写入一致', async () => {
    const proposal = await createInspiration();
    const [confirmed, cancelled] = await Promise.all([confirm(proposal), cancel(proposal)]);
    expect([confirmed.status, cancelled.status].sort()).toEqual([200, 409]);
    const [stored] = await db.select().from(agentProposals);
    const rows = await db.select().from(inspirations);
    expect(rows).toHaveLength(stored.status === 'confirmed' ? 1 : 0);
    expect(stored.status).toBe(confirmed.status === 200 ? 'confirmed' : 'cancelled');
  });

  it('提案状态更新失败会回滚已插入人物，重试可成功', async () => {
    const proposal = await createCharacter();
    // 真实数据库触发器模拟写入之后、更新提案时失败，验证事务而非 mock 调用顺序。
    await query(`CREATE FUNCTION reject_proposal_confirm() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test confirmation failure'; END $$`);
    await query('CREATE TRIGGER reject_proposal_confirm BEFORE UPDATE ON agent_proposals FOR EACH ROW EXECUTE FUNCTION reject_proposal_confirm()');
    try {
      expect((await confirm(proposal)).status).toBe(500);
      await expectNoWrites();
      expect((await db.select().from(agentProposals))[0].status).toBe('pending');
    } finally {
      await query('DROP TRIGGER reject_proposal_confirm ON agent_proposals');
      await query('DROP FUNCTION reject_proposal_confirm()');
    }
    expect((await confirm(proposal)).status).toBe(200);
  });

  it('已确认提案超过有效期后重试仍返回原结果', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - AGENT_PROPOSAL_TTL_MS + 1500);
    let proposal: ProposalView;
    try { proposal = await createInspiration(); } finally { clock.mockRestore(); }
    const first = await confirm(proposal);
    expect(first.status).toBe(200);
    await query('SELECT pg_sleep(1.6)');
    expect((await confirm(proposal)).body).toEqual(first.body);
    expect(await db.select().from(inspirations)).toHaveLength(1);
  });
});

describe('Agent 提案：取消信号与事务提交', () => {
  it('已取消信号在 create/confirm 前阻止写入', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(service.create(book, 'save_character', { name: '甲' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await db.select().from(agentProposals)).toHaveLength(0);
    const proposal = await createCharacter();
    await expect(service.confirm(proposal.id, owner.user.id, proposal.digest, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expectNoWrites();
  });

  it('保存后提交前信号取消导致提案和实际写入一起回滚', async () => {
    const controller = new AbortController();
    const proposal = await createCharacter();
    // 第三次检查发生在写入人物及提案更新之后、COMMIT 之前。
    const check = vi.spyOn(controller.signal, 'throwIfAborted');
    check.mockImplementation(() => {
      if (check.mock.calls.length === 3) controller.abort();
      if (controller.signal.aborted) throw controller.signal.reason;
    });
    await expect(service.confirm(proposal.id, owner.user.id, proposal.digest, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expectNoWrites();
    expect((await db.select().from(agentProposals))[0].status).toBe('pending');
  });

  it('成功提交后才到达的取消信号不得把真实成功报告为取消', async () => {
    const controller = new AbortController();
    const wrapper = Object.create(db) as Database;
    wrapper.transaction = async (callback) => {
      const result = await db.transaction(callback);
      controller.abort(); // 确保取消发生在真正 COMMIT 成功之后。
      return result;
    };
    const wrapped = new AgentProposalsService(wrapper);
    const proposal = await wrapped.create(book, 'save_inspiration', { content: '已提交的提案' }, controller.signal);
    expect(proposal.status).toBe('pending');
    expect(await db.select().from(agentProposals)).toHaveLength(1);
    const confirmController = new AbortController();
    wrapper.transaction = async (callback) => {
      const result = await db.transaction(callback);
      confirmController.abort();
      return result;
    };
    const confirmed = await wrapped.confirm(proposal.id, owner.user.id, proposal.digest, confirmController.signal);
    expect(confirmed.status).toBe('confirmed');
    expect((await db.select().from(inspirations))[0].id).toBe(confirmed.result.id);
  });
});
