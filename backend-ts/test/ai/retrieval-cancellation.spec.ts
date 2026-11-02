import { describe, expect, it, vi } from 'vitest';
import { RagService } from '../../src/rag/rag.service';
import { StoryMemoryService } from '../../src/ai/story-memory.service';
import { StoryToolsService } from '../../src/ai/agent/story-tools';
import type { Book } from '../../src/db/schema';

const book = { id: 'book', title: '测试作品' } as Book;
const emptyDatabase = () => {
  const chain = { select: vi.fn(), from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn() };
  for (const key of ['select', 'from', 'where', 'orderBy'] as const) chain[key].mockReturnValue(chain);
  chain.limit.mockResolvedValue([]);
  return chain;
};

describe('取消传播到工具、作品记忆及向量检索', () => {
  it('检索传入同一 signal；向量化期间取消后不再查询数据库', async () => {
    const abort = new AbortController();
    const db = { select: vi.fn() };
    const embed = vi.fn(async (_texts: string[], signal?: AbortSignal) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
      return [[1]];
    });
    const rag = new RagService(db as never, { embed } as never);
    await expect(rag.searchSimilar('剑法', book.id, 3, abort.signal)).rejects.toThrow();
    expect(embed).toHaveBeenCalledOnce();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('预先取消时不开始任何检索', async () => {
    const abort = new AbortController(); abort.abort();
    const embed = vi.fn();
    const rag = new RagService(null as never, { embed } as never);
    await expect(rag.searchSimilar('剑法', book.id, 3, abort.signal)).rejects.toThrow();
    expect(embed).not.toHaveBeenCalled();
  });

  it('作品记忆中的向量检索取消不会被降级为空背景', async () => {
    const abort = new AbortController();
    const buildRagContext = vi.fn(async (_query, _bookId, signal) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
      signal.throwIfAborted();
      return '';
    });
    const memory = new StoryMemoryService(emptyDatabase() as never, { buildRagContext } as never);
    await expect(memory.buildStoryMemory(book, '剑法', null, null, { signal: abort.signal })).rejects.toThrow();
    expect(buildRagContext).toHaveBeenCalledOnce();
  });

  it('普通检索故障仍允许作品记忆降级', async () => {
    const memory = new StoryMemoryService(emptyDatabase() as never,
      { buildRagContext: vi.fn().mockRejectedValue(new Error('暂不可用')) } as never);
    await expect(memory.buildStoryMemory(book, '剑法', null, null)).resolves.toContain('测试作品');
  });

  it('search_story 把同一 signal 传入 RAG；取消异常不变为 ok:false', async () => {
    const abort = new AbortController();
    const searchSimilar = vi.fn(async (_query, _bookId, _limit, signal) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
      signal.throwIfAborted();
      return [];
    });
    const tools = new StoryToolsService(null as never, { searchSimilar } as never, null as never);
    await expect(tools.execute('search_story', { query: '剑法' }, book, abort.signal)).rejects.toThrow();
  });
});
