import { Inject, Injectable } from '@nestjs/common';
import { and, cosineDistance, eq, isNotNull } from 'drizzle-orm';

import { LLM_CLIENT, type LlmClient } from '../ai/llm/llm-client.interface';
import { DRIZZLE, type Database } from '../db/drizzle.module';
import { documentChunks } from '../db/schema';
import { codePointSlice } from '../shared/text';

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
   */
  splitIntoChunks(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < codePointLengthOf(text)) {
      chunks.push(codePointSlice(text, start, start + CHUNK_SIZE));
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
   * 章节索引：删旧块 → 切段 → 逐块向量化入库。
   * 单块向量化失败只跳过该块，不阻塞章节保存（Python 行为）。
   */
  async indexChapter(chapterId: string, content: string, bookId: string): Promise<void> {
    await this.db.delete(documentChunks).where(eq(documentChunks.chapterId, chapterId));

    const chunks = this.splitIntoChunks(content);
    for (const [i, chunkText] of chunks.entries()) {
      if (!chunkText.trim()) {
        continue;
      }
      let vec: number[];
      try {
        vec = (await this.llm.embed([chunkText]))[0];
      } catch {
        continue;
      }
      await this.db.insert(documentChunks).values({
        bookId,
        chapterId,
        content: chunkText,
        chunkOrder: i,
        embedding: vec, // vector 列的 mapToDriverValue 会转成 '[1,2,...]' 字面量
      });
    }
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

function codePointLengthOf(text: string): number {
  return Array.from(text).length;
}
