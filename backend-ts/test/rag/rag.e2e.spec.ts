import { type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { buildTestApp, registerUser } from '../utils/app';
import { closeTestDb, query, truncateAll } from '../utils/db';
import { RagService } from '../../src/rag/rag.service';

/**
 * RAG 落库测试：保存章节自动索引、重存替换、空白跳过、向量化失败不阻塞保存、
 * 删章节级联删块（Python 版 SQLite 无 FK 会留孤儿行——这里是修复的证明测试）、
 * pgvector 排序 == TS 暴力余弦排序。
 */

let app: INestApplication;

interface ChunkRow {
  id: string;
  chapter_id: string;
  content: string;
  chunk_order: number;
  embedding: string | null;
}

async function chunksOf(chapterId: string): Promise<ChunkRow[]> {
  return query<ChunkRow>(
    'SELECT id, chapter_id, content, chunk_order, embedding::text AS embedding ' +
      'FROM document_chunks WHERE chapter_id = $1 ORDER BY chunk_order',
    [chapterId],
  );
}

async function createBookChapter(auth: Record<string, string>): Promise<{ bookId: string; chapterId: string }> {
  const book = await request(app.getHttpServer()).post('/api/books').set(auth).send({ title: '测试书' });
  const created = await request(app.getHttpServer())
    .post(`/api/books/${book.body.id}/chapters`)
    .set(auth)
    .send({});
  return { bookId: book.body.id as string, chapterId: created.body.id as string };
}

async function saveChapter(auth: Record<string, string>, chapterId: string, content: string) {
  return request(app.getHttpServer())
    .put('/api/chapters/save')
    .set(auth)
    .send({ chapter_id: chapterId, title: null, content });
}

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

describe('章节保存 → 自动向量化索引', () => {
  it('保存 600 字内容 → 写入 2 块（500/100 重叠），embedding 是 1024 维', async () => {
    const { auth } = await registerUser(app, 'rag-1@test.dev');
    const { chapterId } = await createBookChapter(auth);
    const content = '剑'.repeat(600);

    const res = await saveChapter(auth, chapterId, content);
    expect(res.status).toBe(200);

    const rows = await chunksOf(chapterId);
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe('剑'.repeat(500));
    expect(rows[1].content).toBe('剑'.repeat(200)); // 起点 400 → 600-400=200
    expect(rows.map((r) => r.chunk_order)).toEqual([0, 1]);
    for (const row of rows) {
      const dims = row.embedding!.replace(/^\[/, '').replace(/\]$/, '').split(',').length;
      expect(dims).toBe(1024);
    }
  });

  it('重存更短内容 → 旧块被替换（先删后插，不叠加）', async () => {
    const { auth } = await registerUser(app, 'rag-2@test.dev');
    const { chapterId } = await createBookChapter(auth);
    await saveChapter(auth, chapterId, '字'.repeat(600));
    await saveChapter(auth, chapterId, '短内容');

    const rows = await chunksOf(chapterId);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('短内容');
    expect(rows[0].chunk_order).toBe(0);
  });

  it('空白内容 → 0 块（trim 后跳过，不调 embed）', async () => {
    const { auth } = await registerUser(app, 'rag-3@test.dev');
    const { chapterId } = await createBookChapter(auth);
    const res = await saveChapter(auth, chapterId, '   ');
    expect(res.status).toBe(200);
    expect(await chunksOf(chapterId)).toHaveLength(0);
  });

  it('向量化全部失败 → 保存仍成功（不阻塞）', async () => {
    const failing = await buildTestApp({
      embed: async () => {
        throw new Error('embedding 挂了');
      },
    });
    try {
      const { auth } = await registerUser(failing, 'rag-4@test.dev');
      const book = await request(failing.getHttpServer()).post('/api/books').set(auth).send({ title: '书' });
      const created = await request(failing.getHttpServer())
        .post(`/api/books/${book.body.id}/chapters`)
        .set(auth)
        .send({});
      const res = await request(failing.getHttpServer())
        .put('/api/chapters/save')
        .set(auth)
        .send({ chapter_id: created.body.id, title: null, content: '正常正文'.repeat(50) });
      expect(res.status).toBe(200);
      expect(await chunksOf(created.body.id)).toHaveLength(0);
    } finally {
      await failing.close();
    }
  });

  it('删章节 → document_chunks 级联清空（孤儿行修复的证明）', async () => {
    const { auth } = await registerUser(app, 'rag-5@test.dev');
    const { bookId, chapterId } = await createBookChapter(auth);
    await saveChapter(auth, chapterId, '字'.repeat(600));
    expect(await chunksOf(chapterId)).toHaveLength(2);

    const res = await request(app.getHttpServer())
      .delete(`/api/books/${bookId}/chapters/${chapterId}`)
      .set(auth);
    expect(res.status).toBe(204);

    const left = await query('SELECT count(*)::int AS n FROM document_chunks');
    expect(left[0].n).toBe(0);
  });
});

describe('searchSimilar：pgvector 排序 == TS 暴力余弦排序', () => {
  it('用手工向量对照两种排序与分数', async () => {
    // 三个 1024 维基向量：A=e0，B=(e0+e1)/√2，C=e1；查询 q=e0
    // 余弦相似度：A=1 > B≈0.7071 > C=0 → 距离升序 A,B,C
    const dim = 1024;
    const basis = (index: number) => Array.from({ length: dim }, (_, i) => (i === index ? 1 : 0));
    const half = Array.from({ length: dim }, (_, i) => (i < 2 ? 1 / Math.sqrt(2) : 0));

    const vectorByText: Record<string, number[]> = {
      甲文: basis(0),
      乙文: half,
      丙文: basis(1),
    };
    const queryVec = basis(0);

    const custom = await buildTestApp({
      embed: async (texts: string[]) => texts.map((t) => vectorByText[t] ?? queryVec),
    });
    try {
      const { auth } = await registerUser(custom, 'rag-6@test.dev');
      const book = await request(custom.getHttpServer()).post('/api/books').set(auth).send({ title: '书' });
      const bookId = book.body.id as string;

      for (const text of ['甲文', '乙文', '丙文']) {
        const created = await request(custom.getHttpServer())
          .post(`/api/books/${bookId}/chapters`)
          .set(auth)
          .send({});
        await request(custom.getHttpServer())
          .put('/api/chapters/save')
          .set(auth)
          .send({ chapter_id: created.body.id, title: null, content: text });
      }

      const rag = custom.get(RagService);
      const results = await rag.searchSimilar('查询', bookId);
      expect(results.map((r) => r.content)).toEqual(['甲文', '乙文', '丙文']);

      // pgvector 的分数（1 - 余弦距离）应与 TS 侧暴力余弦一致（4 位小数）
      const expected = ['甲文', '乙文', '丙文'].map((t) =>
        Math.round(rag.cosineSimilarity(queryVec, vectorByText[t]) * 10000) / 10000,
      );
      expect(results.map((r) => r.score)).toEqual(expected);
      expect(expected[0]).toBe(1);
      expect(expected[1]).toBeCloseTo(0.7071, 4);
      expect(expected[2]).toBe(0);
    } finally {
      await custom.close();
    }
  });

  it('只查当前书；空结果 → buildRagContext 返回空串', async () => {
    const { auth } = await registerUser(app, 'rag-7@test.dev');
    const other = await registerUser(app, 'rag-7-other@test.dev');
    const emptyBook = await request(app.getHttpServer()).post('/api/books').set(auth).send({ title: '空书' });
    const mine = await createBookChapter(auth);
    await saveChapter(auth, mine.chapterId, '我在自己的书里写了一段独特的内容。');

    const theirs = await createBookChapter(other.auth);
    await saveChapter(other.auth, theirs.chapterId, '别人书里的内容'.repeat(20));

    const rag = app.get(RagService);
    // 我的查询只命中我的书
    const mineHits = await rag.searchSimilar('独特的内容', mine.bookId);
    expect(mineHits.length).toBeGreaterThan(0);
    expect(mineHits[0].content).toContain('独特的内容');
    // 别人的块不在我的结果里；没有块的书 → 空结果
    expect(mineHits.some((r) => r.content.includes('别人书里'))).toBe(false);
    expect(await rag.searchSimilar('独特的内容', emptyBook.body.id)).toHaveLength(0);

    // 空库 → 空串；有结果 → [相关背景] 包装
    expect(await rag.buildRagContext('任何查询', emptyBook.body.id)).toBe('');
    const context = await rag.buildRagContext('独特的内容', mine.bookId);
    expect(context.startsWith('[相关背景]\n')).toBe(true);
    expect(context.endsWith('\n[/相关背景]')).toBe(true);
    expect(context).toContain('独特的内容');
  });
});
