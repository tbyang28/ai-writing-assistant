import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { buildTestApp, registerUser } from './utils/app';
import { closeTestDb, truncateAll } from './utils/db';

/** 章节路由 —— 对应 routers/books.py 的 Chapters 段 */

let app: INestApplication;
let seq = 0;
const nextEmail = () => `chapters-${Date.now()}-${seq++}@test.dev`;

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

interface Ctx {
  auth: Record<string, string>;
  bookId: string;
}

async function setup(): Promise<Ctx> {
  const { auth } = await registerUser(app, nextEmail());
  const book = await request(app.getHttpServer())
    .post('/api/books')
    .set(auth)
    .send({ title: '章节测试书' });
  return { auth, bookId: book.body.id };
}

describe('POST /api/books/:id/chapters', () => {
  it('空字符串标题 → 自动「第一章/第二章」连续编号', async () => {
    const { auth, bookId } = await setup();
    const c1 = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '' });
    expect(c1.status).toBe(201);
    expect(c1.body.title).toBe('第一章');
    expect(c1.body.order).toBe(1);
    expect(c1.body.status).toBe('DRAFT');
    expect(c1.body.word_count).toBe(0);

    const c2 = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '' });
    expect(c2.body.title).toBe('第二章');
    expect(c2.body.order).toBe(2);

    const c13 = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: null });
    expect(c13.body.title).toBe('第三章');
  });

  it('缺省 title → 未命名章节（pydantic 默认值语义）', async () => {
    const { auth, bookId } = await setup();
    const res = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('未命名章节');
  });

  it('显式标题优先；不存在的书 → 404 作品不存在', async () => {
    const { auth, bookId } = await setup();
    const res = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '序章' });
    expect(res.body.title).toBe('序章');

    const missing = await request(app.getHttpServer())
      .post('/api/books/00000000-0000-0000-0000-000000000abc/chapters')
      .set(auth)
      .send({});
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ detail: '作品不存在' });
  });
});

describe('PUT /api/chapters/save', () => {
  it('保存正文重算字数并同步书籍总字数', async () => {
    const { auth, bookId } = await setup();
    const chapter = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '' });

    const res = await request(app.getHttpServer())
      .put('/api/chapters/save')
      .set(auth)
      .send({ chapter_id: chapter.body.id, content: '你好 世界\n第二行' });
    expect(res.status).toBe(200);
    // 「你好世界第二行」7 个字（空格和 \n 被剥掉）
    expect(res.body.word_count).toBe(7);

    const book = await request(app.getHttpServer()).get(`/api/books/${bookId}`).set(auth);
    expect(book.body.word_count).toBe(7);
  });

  it('改标题不动字数，但书籍总字数仍会重算', async () => {
    const { auth, bookId } = await setup();
    const chapter = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '' });
    await request(app.getHttpServer())
      .put('/api/chapters/save')
      .set(auth)
      .send({ chapter_id: chapter.body.id, content: '四字正文' });

    const res = await request(app.getHttpServer())
      .put('/api/chapters/save')
      .set(auth)
      .send({ chapter_id: chapter.body.id, title: '新标题' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('新标题');
    expect(res.body.word_count).toBe(4);

    const book = await request(app.getHttpServer()).get(`/api/books/${bookId}`).set(auth);
    expect(book.body.word_count).toBe(4);
  });

  it('他人章节 → 404 章节不存在', async () => {
    const { auth, bookId } = await setup();
    const stranger = await registerUser(app, nextEmail());
    const chapter = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '' });

    const res = await request(app.getHttpServer())
      .put('/api/chapters/save')
      .set(stranger.auth)
      .send({ chapter_id: chapter.body.id, content: '越权写入' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: '章节不存在' });
  });
});

describe('GET /chapters/:id 与 PUT /books/:bid/chapters/:cid', () => {
  it('读取、改标题/状态', async () => {
    const { auth, bookId } = await setup();
    const chapter = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '' });

    const got = await request(app.getHttpServer())
      .get(`/api/chapters/${chapter.body.id}`)
      .set(auth);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(chapter.body.id);

    const updated = await request(app.getHttpServer())
      .put(`/api/books/${bookId}/chapters/${chapter.body.id}`)
      .set(auth)
      .send({ title: '改名了', status: 'PUBLISHED' });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('改名了');
    expect(updated.body.status).toBe('PUBLISHED');
  });
});

describe('DELETE 与 publish', () => {
  it('删除 → 204，书里不再有该章', async () => {
    const { auth, bookId } = await setup();
    const chapter = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '' });

    const res = await request(app.getHttpServer())
      .delete(`/api/books/${bookId}/chapters/${chapter.body.id}`)
      .set(auth);
    expect(res.status).toBe(204);

    const book = await request(app.getHttpServer()).get(`/api/books/${bookId}`).set(auth);
    expect(book.body.chapters).toHaveLength(0);
  });

  it('publish → status PUBLISHED；chapter_id 缺失 → 404（对齐 Python 裸 dict 行为）', async () => {
    const { auth, bookId } = await setup();
    const chapter = await request(app.getHttpServer())
      .post(`/api/books/${bookId}/chapters`)
      .set(auth)
      .send({ title: '' });

    const published = await request(app.getHttpServer())
      .post('/api/chapters/publish')
      .set(auth)
      .send({ chapter_id: chapter.body.id });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('PUBLISHED');

    const missing = await request(app.getHttpServer())
      .post('/api/chapters/publish')
      .set(auth)
      .send({});
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ detail: '章节不存在' });
  });
});
