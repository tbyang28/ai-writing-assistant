import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { buildTestApp, registerUser } from './utils/app';
import { closeTestDb, truncateAll } from './utils/db';

/** 书籍 CRUD + 统计 + demo 种子 —— 对应 backend/tests/routers/test_books_routes.py */

let app: INestApplication;
let seq = 0;
const nextEmail = () => `books-${Date.now()}-${seq++}@test.dev`;

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

async function createBook(auth: Record<string, string>, title = '测试书') {
  return request(app.getHttpServer()).post('/api/books').set(auth).send({ title });
}

describe('POST /api/books', () => {
  it('创建成功 → 201，返回 BookListResponse 形状', async () => {
    const { auth } = await registerUser(app, nextEmail());
    const res = await createBook(auth, '我的小说');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: '我的小说',
      cover: '',
      description: '',
      status: 'DRAFT',
      word_count: 0,
    });
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.owner_id).toBe('string');
    expect(res.body.created_at).toBeTruthy();
  });

  it('缺 title → 400 {"detail": "..."}', async () => {
    const { auth } = await registerUser(app, nextEmail());
    const res = await request(app.getHttpServer()).post('/api/books').set(auth).send({});
    expect(res.status).toBe(400);
    expect(typeof res.body.detail).toBe('string');
  });
});

describe('GET /api/books 与 /api/books/:id', () => {
  it('列表只含本人的书，按 updated_at 倒序', async () => {
    const { auth } = await registerUser(app, nextEmail());
    await createBook(auth, '书A');
    await new Promise((r) => setTimeout(r, 15));
    await createBook(auth, '书B');

    const res = await request(app.getHttpServer()).get('/api/books').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].title).toBe('书B');
    expect(res.body[1].title).toBe('书A');
  });

  it('详情返回 5 个集合；他人书籍/不存在 → 404 作品不存在', async () => {
    const alice = await registerUser(app, nextEmail());
    const bob = await registerUser(app, nextEmail());
    const created = await createBook(alice.auth, '私密书');
    const bookId = created.body.id;

    const ok = await request(app.getHttpServer()).get(`/api/books/${bookId}`).set(alice.auth);
    expect(ok.status).toBe(200);
    expect(ok.body.chapters).toEqual([]);
    expect(ok.body.outlines).toEqual([]);
    expect(ok.body.characters).toEqual([]);
    expect(ok.body.character_relations).toEqual([]);
    expect(ok.body.inspirations).toEqual([]);

    const stranger = await request(app.getHttpServer()).get(`/api/books/${bookId}`).set(bob.auth);
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual({ detail: '作品不存在' });

    const missing = await request(app.getHttpServer())
      .get('/api/books/00000000-0000-0000-0000-000000000abc')
      .set(alice.auth);
    expect(missing.status).toBe(404);
  });

  it('非 UUID 的 :id 也返回 404（对齐 Python 而不是 400）', async () => {
    const { auth } = await registerUser(app, nextEmail());
    const res = await request(app.getHttpServer()).get('/api/books/not-a-uuid').set(auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: '作品不存在' });
  });
});

describe('PUT / DELETE /api/books/:id', () => {
  it('部分更新只动传入字段', async () => {
    const { auth } = await registerUser(app, nextEmail());
    const created = await createBook(auth, '原名');
    const res = await request(app.getHttpServer())
      .put(`/api/books/${created.body.id}`)
      .set(auth)
      .send({ description: '新简介', status: 'SERIAL' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('原名');
    expect(res.body.description).toBe('新简介');
    expect(res.body.status).toBe('SERIAL');
  });

  it('删除 → 204 无正文；再查 404；他人删自己的书 → 404', async () => {
    const alice = await registerUser(app, nextEmail());
    const bob = await registerUser(app, nextEmail());
    const created = await createBook(alice.auth);

    const stranger = await request(app.getHttpServer())
      .delete(`/api/books/${created.body.id}`)
      .set(bob.auth);
    expect(stranger.status).toBe(404);

    const res = await request(app.getHttpServer())
      .delete(`/api/books/${created.body.id}`)
      .set(alice.auth);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    const gone = await request(app.getHttpServer())
      .get(`/api/books/${created.body.id}`)
      .set(alice.auth);
    expect(gone.status).toBe(404);
  });
});

describe('统计接口', () => {
  it('books/stats 反映书籍与章节数（路由序回归：stats 不被 :id 吞掉）', async () => {
    const { auth } = await registerUser(app, nextEmail());
    const book = await createBook(auth, '统计书');
    await request(app.getHttpServer())
      .post(`/api/books/${book.body.id}/chapters`)
      .set(auth)
      .send({ title: '' });

    const res = await request(app.getHttpServer()).get('/api/books/stats').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalBooks: 1,
      totalWords: 0,
      totalChapters: 1,
      serialBooks: 0,
      finishedBooks: 0,
    });

    const serial = await request(app.getHttpServer())
      .put(`/api/books/${book.body.id}`)
      .set(auth)
      .send({ status: 'SERIAL' });
    expect(serial.status).toBe(200);
    const stats2 = await request(app.getHttpServer()).get('/api/books/stats').set(auth);
    expect(stats2.body.serialBooks).toBe(1);
  });

  it('stats（写作统计）返回今日/总数/连续天数与最近 7 天', async () => {
    const { auth } = await registerUser(app, nextEmail());
    const book = await createBook(auth, '写作统计书');
    const chapter = await request(app.getHttpServer())
      .post(`/api/books/${book.body.id}/chapters`)
      .set(auth)
      .send({ title: '第一章' });

    // 保存正文 → 今日字数
    await request(app.getHttpServer())
      .put('/api/chapters/save')
      .set(auth)
      .send({ chapter_id: chapter.body.id, content: '今天写了八个字' });

    const res = await request(app.getHttpServer()).get('/api/stats').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.total_word_count).toBe(7);
    expect(res.body.today_word_count).toBe(7);
    expect(res.body.streak_days).toBeGreaterThanOrEqual(1);
    expect(res.body.active_days).toBe(res.body.streak_days);
    expect(res.body.last_7_days).toHaveLength(7);
    const todayEntry = res.body.last_7_days[res.body.last_7_days.length - 1];
    expect(todayEntry.wordCount).toBe(7);
    expect(todayEntry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('POST /api/demo/seed', () => {
  it('种出完整演示书：3 章 + 1 大纲 + 6 角色 + 7 关系 + 2 灵感，幂等', async () => {
    const { auth } = await registerUser(app, nextEmail());

    const res = await request(app.getHttpServer()).post('/api/demo/seed').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('雨巷边缘');
    expect(res.body.status).toBe('SERIAL');
    expect(res.body.chapters).toHaveLength(3);
    expect(res.body.chapters.map((c: { title: string }) => c.title)).toEqual([
      '入学',
      '旧照片',
      '雨夜短信',
    ]);
    expect(res.body.outlines).toHaveLength(1);
    expect(res.body.characters).toHaveLength(6);
    expect(res.body.character_relations).toHaveLength(7);
    expect(res.body.inspirations).toHaveLength(2);

    // 字数：章节 word_count 与 book.word_count = 三章之和
    const sum = res.body.chapters.reduce(
      (acc: number, c: { word_count: number }) => acc + c.word_count,
      0,
    );
    expect(sum).toBeGreaterThan(0);
    expect(res.body.word_count).toBe(sum);

    // tags 是 JSON 字符串（契约）
    expect(typeof res.body.inspirations[0].tags).toBe('string');
    expect(JSON.parse(res.body.inspirations[0].tags)).toContain('悬疑');

    // 幂等：再次 seed 返回同一本书
    const again = await request(app.getHttpServer()).post('/api/demo/seed').set(auth);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(res.body.id);
    expect(again.body.chapters).toHaveLength(3);
  });
});
