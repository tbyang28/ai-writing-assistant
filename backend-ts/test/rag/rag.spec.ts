import { describe, expect, it } from 'vitest';

import { RagService } from '../../src/rag/rag.service';

/** 纯函数测试：DI 参数传 null（不触库不触 LLM） */
const service = new RagService(null as never, null as never);

describe('splitIntoChunks（500 字 / 100 字重叠）', () => {
  it('空文本 → [""]（Python: chunks or [text]）', () => {
    expect(service.splitIntoChunks('')).toEqual(['']);
  });

  it('短文本不切', () => {
    expect(service.splitIntoChunks('张三拔剑。')).toEqual(['张三拔剑。']);
  });

  it('恰好 500 字 → 2 段（第二段是起点 400 的尾巴 100 字——Python 同样的步进行为）', () => {
    const chunks = service.splitIntoChunks('字'.repeat(500));
    expect(chunks.map((c) => Array.from(c).length)).toEqual([500, 100]);
  });

  it('501 字 → 2 段（第二段从 400 起，101 字）', () => {
    const text = Array.from({ length: 501 }, (_, i) => String(i % 10)).join('');
    const chunks = service.splitIntoChunks(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(text.slice(0, 500));
    expect(chunks[1]).toBe(text.slice(400)); // 重叠 100
  });

  it('1100 字 → 3 段（500/500/300，起点 0/400/800）', () => {
    const chunks = service.splitIntoChunks('字'.repeat(1100));
    expect(chunks.map((c) => Array.from(c).length)).toEqual([500, 500, 300]);
  });

  it('按码点切，不切坏星形字符（代理对）', () => {
    const text = '𝐀'.repeat(600); // 600 码点 = 1200 个 UTF-16 单元
    const chunks = service.splitIntoChunks(text);
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0])).toHaveLength(500);
    // 没有切出落单的代理项：每个码点都仍是完整的星形字符
    expect(chunks.every((c) => Array.from(c).every((ch) => ch === '𝐀'))).toBe(true);
  });
});

describe('cosineSimilarity', () => {
  it('同向 → 1', () => {
    expect(service.cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('正交 → 0', () => {
    expect(service.cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('零向量 → 0（防除零）', () => {
    expect(service.cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('已知值：[1,0]·[1,1] = 1/√2', () => {
    expect(service.cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(1 / Math.sqrt(2), 10);
  });
});
