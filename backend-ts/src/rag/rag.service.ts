import { Inject, Injectable } from '@nestjs/common';
import { and, cosineDistance, eq, isNotNull } from 'drizzle-orm';

import { LLM_CLIENT, type LlmClient } from '../ai/llm/llm-client.interface';
import { DRIZZLE, type Database } from '../db/drizzle.module';
import { documentChunks } from '../db/schema';

/** 每段文本切多大（字符数）—— Python 版常量一致 */
export const CHUNK_SIZE = 500;
/** 段与段之间重叠多少字符（防止关键信息被切在边界） */
export const CHUNK_OVERLAP = 100;
/** 每次搜索返回几段 */
export const TOP_K = 5;

/**
 * RAG 检索增强 —— 对应 rag_service.py。
 *
 * 差别：Python 把向量以 JSON 字符串存 TEXT，检索时全表载入、Python 循环算余弦；
 * 这里用 pgvector 的 vector(1024) 列 + cosineDistance 在库内排序取 top-5。
 * splitIntoChunks / cosineSimilarity 保持纯函数（供测试与对照）。
 */
@Injectable()
export class RagService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  /**
   * 把长文本切成短段，段间重叠 —— Python 版逐码点切片：
   * chunks.append(text[start:end]); start += CHUNK_SIZE - CHUNK_OVERLAP
   *
   * 性能：只做一次 Array.from 全文展开，循环里对数组切片。
   * 若每个块都走 codePointSlice(全文)，是 O(块数 × 全长) 的平方开销
   * （10 万字章节 ≈ 250 块 × 10 万码点），Python 的 text[start:end] 没有这个问题。
   */
  splitIntoChunks(text: string): string[] {
    const chars = Array.from(text);
    const chunks: string[] = [];
    let start = 0;
    while (start < chars.length) {
      chunks.push(chars.slice(start, start + CHUNK_SIZE).join(''));
      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
    return chunks.length > 0 ? chunks : [text];
  }

  /** 余弦相似度（纯函数，供测试与 pgvector 结果对照） */
  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    return normA * normB > 0 ? dot / (normA * normB) : 0;
  }

  /**
   * 章节索引：切段 → 逐块向量化（失败跳过）→ 事务内删旧插新。
   *
   * 结构取舍：embedding 是外部 HTTP 调用，放在事务外逐块做
   * （避免长时间占用连接池）；delete + 批量 insert 包成一个事务，
   * 中途失败整体回滚，不会留下「旧块删了一半、新块插了一半」的中间态。
   */
  async indexChapter(chapterId: string, content: string, bookId: string): Promise<void> {
    const ready: Array<{ order: number; text: string; vec: number[] }> = [];
    for (const [i, chunkText] of this.splitIntoChunks(content).entries()) {
      if (!chunkText.trim()) {
        continue; // Python：空白块跳过
      }
      try {
        const vec = (await this.llm.embed([chunkText]))[0];
        ready.push({ order: i, text: chunkText, vec });
      } catch {
        continue; // 向量化失败不阻塞章节保存（Python 行为）
      }
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(documentChunks).where(eq(documentChunks.chapterId, chapterId));
      if (ready.length > 0) {
        await tx.insert(documentChunks).values(
          ready.map(({ order, text, vec }) => ({
            bookId,
            chapterId,
            content: text,
            chunkOrder: order,
            embedding: vec, // vector 列的 mapToDriverValue 会转成 '[1,2,...]' 字面量
          })),
        );
      }
    });
  }

  /** 语义搜索：query 向量化后按余弦距离在库内取 top-k */
  async searchSimilar(query: string, bookId: string, topK = TOP_K) {
    const [queryVec] = await this.llm.embed([query]);
    const distance = cosineDistance(documentChunks.embedding, queryVec);

    const rows = await this.db
      .select({ content: documentChunks.content, distance })
      .from(documentChunks)
      .where(and(eq(documentChunks.bookId, bookId), isNotNull(documentChunks.embedding)))
      .orderBy(distance)
      .limit(topK);

    return rows.map((row) => ({
      content: row.content,
      score: round4(1 - Number(row.distance)),
    }));
  }

  /** 拼装 RAG 上下文块（[相关背景]…[/相关背景]），无结果返回空串 */
  async buildRagContext(query: string, bookId: string): Promise<string> {
    const results = await this.searchSimilar(query, bookId);
    if (results.length === 0) {
      return '';
    }
    const lines = ['[相关背景]'];
    for (const r of results) {
      lines.push(r.content);
    }
    lines.push('[/相关背景]');
    return lines.join('\n');
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
