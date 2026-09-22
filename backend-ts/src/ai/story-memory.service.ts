import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/drizzle.module';
import { chapters, characters, outlines, type Book, type Chapter } from '../db/schema';
import { RagService } from '../rag/rag.service';
import { codePointSlice } from '../shared/text';

/** story memory 的可调参数（polish 变体会整体覆盖一组更紧的值） */
export interface StoryMemoryOptions {
  previousChapterLimit: number;
  previousChapterChars: number;
  characterLimit: number;
  outlineLimit: number;
  currentChars: number;
  includeRag: boolean;
}

export const DEFAULT_MEMORY_OPTIONS: StoryMemoryOptions = {
  previousChapterLimit: 3,
  previousChapterChars: 1600,
  characterLimit: 12,
  outlineLimit: 8,
  currentChars: 3000,
  includeRag: true,
};

/** polish_diff 的覆盖组（更小的上下文窗口，不含 RAG） */
export const POLISH_MEMORY_OPTIONS: StoryMemoryOptions = {
  previousChapterLimit: 1,
  previousChapterChars: 600,
  characterLimit: 8,
  outlineLimit: 4,
  currentChars: 800, // 由调用方按 selected_text 与否改为 0
  includeRag: false,
};

/**
 * 作品记忆 —— 移植 routers/ai.py 的 _build_story_memory。
 * 把「同一本书」的设定（人物/大纲/前文章节/RAG 检索/当前草稿）压成一个
 * 紧凑文本块，作为 user prompt 的前半部分喂给模型。
 */
@Injectable()
export class StoryMemoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly rag: RagService,
  ) {}

  async buildStoryMemory(
    book: Book,
    query: string,
    chapterId: string | null,
    currentContent: string | null,
    options: Partial<StoryMemoryOptions> = {},
  ): Promise<string> {
    const opts = { ...DEFAULT_MEMORY_OPTIONS, ...options };

    const currentChapter = await this.getCurrentChapter(chapterId);
    const previousChapters = await this.getRecentBookChapters(
      book.id,
      currentChapter,
      opts.previousChapterLimit,
    );

    const characterRows = await this.db
      .select()
      .from(characters)
      .where(eq(characters.bookId, book.id))
      .orderBy(asc(characters.createdAt), asc(characters.id))
      .limit(opts.characterLimit);

    const outlineRows = await this.db
      .select()
      .from(outlines)
      .where(eq(outlines.bookId, book.id))
      .orderBy(asc(outlines.order))
      .limit(opts.outlineLimit);

    let ragContext = '';
    if (opts.includeRag && query.trim()) {
      try {
        ragContext = await this.rag.buildRagContext(codePointSlice(query, 0, 1000), book.id);
      } catch {
        ragContext = ''; // RAG 失败不阻塞 AI 调用
      }
    }

    const parts: string[] = ['【作品记忆】', `作品名：${book.title}`];
    if (book.description) {
      parts.push(`作品简介：${codePointSlice(book.description, 0, 500)}`);
    }

    if (characterRows.length > 0) {
      const lines = characterRows.map((c) => {
        const role = c.role ? `（${c.role}）` : '';
        const bio = c.bio ? `：${codePointSlice(c.bio, 0, 120)}` : '';
        return `- ${c.name}${role}${bio}`;
      });
      parts.push(`【人物设定】\n${lines.join('\n')}`);
    }

    if (outlineRows.length > 0) {
      const lines = outlineRows.map((o) =>
        o.content ? `- ${o.title}：${codePointSlice(o.content, 0, 180)}` : `- ${o.title}`,
      );
      parts.push(`【大纲/设定】\n${lines.join('\n')}`);
    }

    if (previousChapters.length > 0) {
      const historyParts: string[] = [];
      for (const chapter of previousChapters) {
        const text = (chapter.content ?? '').trim();
        if (!text) {
          continue;
        }
        const tail =
          codePointLengthOf(text) > opts.previousChapterChars
            ? codePointSlice(text, -opts.previousChapterChars)
            : text;
        historyParts.push(`【${chapter.title}】\n${tail}`);
      }
      if (historyParts.length > 0) {
        parts.push(`【最近前文章节】\n${historyParts.join('\n\n')}`);
      }
    }

    if (ragContext) {
      parts.push(ragContext);
    }

    const current = (currentContent ?? '').trim();
    if (current && opts.currentChars > 0) {
      parts.push(`【当前章节草稿】\n${codePointSlice(current, 0, opts.currentChars)}`);
    }

    parts.push(
      '【使用要求】回答必须严格承接同一本书的前文、人物关系和当前章节，不要凭空换主角、换世界观或重开剧情。',
    );
    return parts.join('\n\n');
  }

  /** Python 的 _get_current_chapter：只按 id 取，不校验归属（保持一致） */
  private async getCurrentChapter(chapterId: string | null): Promise<Chapter | null> {
    if (!chapterId || !isUuid(chapterId)) {
      return null;
    }
    const rows = await this.db
      .select()
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 当前章之前的最近 N 章，按 order 正序返回 */
  private async getRecentBookChapters(
    bookId: string,
    currentChapter: Chapter | null,
    limit: number,
  ): Promise<Chapter[]> {
    if (limit <= 0) {
      return [];
    }
    const conditions = currentChapter
      ? and(eq(chapters.bookId, bookId), lt(chapters.order, currentChapter.order))
      : eq(chapters.bookId, bookId);

    const rows = await this.db
      .select()
      .from(chapters)
      .where(conditions)
      .orderBy(desc(chapters.order))
      .limit(limit);
    return rows.reverse();
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function codePointLengthOf(text: string): number {
  return Array.from(text).length;
}
