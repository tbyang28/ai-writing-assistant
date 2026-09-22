import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { buildTestApp, registerUser } from './utils/app';
import { closeTestDb, truncateAll } from './utils/db';

/**
 * 设定库（大纲/角色/关系/灵感）—— 对应 routers/books.py 后半段。
 * 重点覆盖 3 处越权写洞的修复（Python 版任何登录用户可往他人书里写数据）。
 */

let app: INestApplication;
let seq = 0;
const nextEmail = () => `library-${Date.now()}-${seq++}@test.dev`;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

beforeEach(async () => {
  await truncateAll();
});

async function setup() {
  const alice = await registerUser(app, nextEmail());
  const bob = await registerUser(app, nextEmail());
  const book = await request(app.getHttpServer())
    .post('/api/books')
    .set(alice.auth)
    .send({ title: '设定库书' });
  return { alice, bob, bookId: book.body.id as string };
}

describe('outlines', () => {
  it('创建自动 order 递增，列表按 order 排序', async () => {
    const { alice, bookId } = await setup();
    const o1 = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/outlines`)
      .set(alice.auth)
      .send({ title: '第一卷', content: '卷一内容' });
    expect(o1.status).toBe(201);
    expect(o1.body.order).toBe(1);

    const o2 = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/outlines`)
      .set(alice.auth)
      .send({ title: '第二卷' });
    expect(o2.body.order).toBe(2);
    expect(o2.body.content).toBe('');

    const list = await request(app.getHttpServer())
      .get(`/api/books/${bookId}/outlines`)
      .set(alice.auth);
    expect(list.status).toBe(200);
    expect(list.body.map((o: { title: string }) => o.title)).toEqual(['第一卷', '第二卷']);
  });

  it('越权修复：他人向我的书创建大纲 → 404 作品不存在', async () => {
    const { alice, bob, bookId } = await setup();
    const res = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/outlines`)
      .set(bob.auth)
      .send({ title: '入侵大纲' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: '作品不存在' });

    // 库里确实没被写入
    const list = await request(app.getHttpServer())
      .get(`/api/books/${bookId}/outlines`)
      .set(alice.auth);
    expect(list.body).toHaveLength(0);
  });
});

describe('characters', () => {
  it('创建与列表（按创建时间正序）', async () => {
    const { alice, bookId } = await setup();
    const c1 = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/characters`)
      .set(alice.auth)
      .send({ name: '主角', role: '主角', bio: '生平' });
    expect(c1.status).toBe(201);
    expect(c1.body.name).toBe('主角');
    expect(c1.body.role).toBe('主角');

    await request(app.getHttpServer())
      .post(`/api/books/${bookId}/characters`)
      .set(alice.auth)
      .send({ name: '配角' });

    const list = await request(app.getHttpServer())
      .get(`/api/books/${bookId}/characters`)
      .set(alice.auth);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(['主角', '配角']);
  });

  it('越权修复：他人创建角色 → 404', async () => {
    const { bob, bookId } = await setup();
    const res = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/characters`)
      .set(bob.auth)
      .send({ name: '间谍' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: '作品不存在' });
  });
});

describe('character relations', () => {
  async function twoCharacters(alice: { auth: Record<string, string> }, bookId: string) {
    const a = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/characters`)
      .set(alice.auth)
      .send({ name: '甲' });
    const b = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/characters`)
      .set(alice.auth)
      .send({ name: '乙' });
    return { aId: a.body.id as string, bId: b.body.id as string };
  }

  it('创建关系：strength 夹在 1-5；列表按创建时间倒序', async () => {
    const { alice, bookId } = await setup();
    const { aId, bId } = await twoCharacters(alice, bookId);

    const r1 = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/character-relations`)
      .set(alice.auth)
      .send({
        source_character_id: aId,
        target_character_id: bId,
        relation_type: 'ally',
        description: '并肩作战',
        strength: 99,
      });
    expect(r1.status).toBe(201);
    expect(r1.body.strength).toBe(5);

    const r2 = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/character-relations`)
      .set(alice.auth)
      .send({ source_character_id: bId, target_character_id: aId, strength: 0 });
    expect(r2.body.strength).toBe(1);
    expect(r2.body.relation_type).toBe('ally'); // 默认值

    const list = await request(app.getHttpServer())
      .get(`/api/books/${bookId}/character-relations`)
      .set(alice.auth);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].id).toBe(r2.body.id); // 新的在前

    // 删除 → 204 → 再删 404 关系不存在
    const del = await request(app.getHttpServer())
      .delete(`/api/books/${bookId}/character-relations/${r1.body.id}`)
      .set(alice.auth);
    expect(del.status).toBe(204);
    const again = await request(app.getHttpServer())
      .delete(`/api/books/${bookId}/character-relations/${r1.body.id}`)
      .set(alice.auth);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ detail: '关系不存在' });
  });

  it('自身关系 → 400；角色不存在 → 400', async () => {
    const { alice, bookId } = await setup();
    const { aId } = await twoCharacters(alice, bookId);

    const self = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/character-relations`)
      .set(alice.auth)
      .send({ source_character_id: aId, target_character_id: aId });
    expect(self.status).toBe(400);
    expect(self.body).toEqual({ detail: '不能创建角色自身关系' });

    const missing = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/character-relations`)
      .set(alice.auth)
      .send({
        source_character_id: aId,
        target_character_id: '00000000-0000-0000-0000-00000000feed',
      });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ detail: '关系中的角色不存在' });
  });
});

describe('inspirations', () => {
  it('创建：tags 是 JSON 字符串（Python ensure_ascii 形态）；列表倒序', async () => {
    const { alice, bookId } = await setup();
    const res = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/inspirations`)
      .set(alice.auth)
      .send({ title: '灵感', content: '内容', tags: ['悬疑', '校园'] });
    expect(res.status).toBe(201);
    // json.dumps 默认 ensure_ascii=True：中文转 \uXXXX（复刻 Python 不一致行为）
    expect(res.body.tags).toBe('["\\u60ac\\u7591", "\\u6821\\u56ed"]');
    expect(JSON.parse(res.body.tags)).toEqual(['悬疑', '校园']);

    const noTags = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/inspirations`)
      .set(alice.auth)
      .send({ title: '无标签', content: 'x' });
    expect(noTags.body.tags).toBe('[]');

    const list = await request(app.getHttpServer())
      .get(`/api/books/${bookId}/inspirations`)
      .set(alice.auth);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].title).toBe('无标签');
  });

  it('越权修复：他人创建灵感 → 404', async () => {
    const { bob, bookId } = await setup();
    const res = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/inspirations`)
      .set(bob.auth)
      .send({ title: '入侵', content: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: '作品不存在' });
  });
});
