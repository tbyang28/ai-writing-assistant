import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/drizzle.module';
import {
  books,
  chapters,
  characters,
  characterRelations,
  inspirations,
  outlines,
  type Book,
} from '../db/schema';
import { wordCount, pyJsonDumpsList } from '../shared/text';
import {
  DEMO_BOOK_TITLE,
  DEMO_CHAPTERS,
  DEMO_CHARACTERS,
  DEMO_INSPIRATIONS,
  DEMO_OUTLINE,
  DEMO_OUTLINE_TITLE,
  DEMO_RELATIONS,
  DEMO_DESCRIPTION,
} from './demo-seed';
import { toBookListPayload, toBookResponse } from './mappers';

/**
 * 书籍/统计/种子服务 —— 对应 routers/books.py 的查询部分。
 * Python 版 stats 是 N+1（每本书再查一遍章节），这里改为固定 2-3 条聚合 SQL。
 */
@Injectable()
export class BooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** 按 id + owner 取书，查不到返回 null（调用方负责抛 404 作品不存在） */
  async findOwnedBook(bookId: string, ownerId: string): Promise<Book | null> {
    const rows = await this.db
      .select()
      .from(books)
      .where(and(eq(books.id, bookId), eq(books.ownerId, ownerId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 单书的 5 个集合 —— Python 用 selectinload 一次带出（无排序，实际是行序）。
   * 这里显式排序：chapters/outlines 按 order，其余按 created_at（插入序）。
   */
  async loadCollections(bookId: string) {
    const [chapterRows, outlineRows, characterRows, relationRows, inspirationRows] =
      await Promise.all([
        this.db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.order)),
        this.db.select().from(outlines).where(eq(outlines.bookId, bookId)).orderBy(asc(outlines.order)),
        this.db
          .select()
          .from(characters)
          .where(eq(characters.bookId, bookId))
          .orderBy(asc(characters.createdAt), asc(characters.id)),
        this.db
          .select()
          .from(characterRelations)
          .where(eq(characterRelations.bookId, bookId))
          .orderBy(asc(characterRelations.createdAt), asc(characterRelations.id)),
        this.db
          .select()
          .from(inspirations)
          .where(eq(inspirations.bookId, bookId))
          .orderBy(asc(inspirations.createdAt), asc(inspirations.id)),
      ]);
    return {
      chapters: chapterRows,
      outlines: outlineRows,
      characters: characterRows,
      characterRelations: relationRows,
      inspirations: inspirationRows,
    };
  }

  /** GET /books/:id 的完整响应；书不存在返回 null */
  async getBookDetail(bookId: string, ownerId: string) {
    const book = await this.findOwnedBook(bookId, ownerId);
    if (!book) {
      return null;
    }
    const collections = await this.loadCollections(bookId);
    return toBookResponse(book, collections);
  }

  /** GET /books 列表，按 updated_at 倒序 */
  async listBooks(ownerId: string) {
    const rows = await this.db
      .select()
      .from(books)
      .where(eq(books.ownerId, ownerId))
      .orderBy(sql`${books.updatedAt} desc`);
    return rows.map(toBookListPayload);
  }

  /** GET /books/stats —— Python 版 1+B 条查询，这里固定 2 条 */
  async bookStats(ownerId: string) {
    const [bookAgg] = await this.db
      .select({
        totalBooks: sql<number>`count(*)`,
        totalWords: sql<number>`coalesce(sum(${books.wordCount}), 0)`,
        serialBooks: sql<number>`count(*) filter (where ${books.status} = 'SERIAL')`,
        finishedBooks: sql<number>`count(*) filter (where ${books.status} = 'FINISHED')`,
      })
      .from(books)
      .where(eq(books.ownerId, ownerId));

    const [chapterAgg] = await this.db
      .select({ totalChapters: sql<number>`count(*)` })
      .from(chapters)
      .innerJoin(books, eq(chapters.bookId, books.id))
      .where(eq(books.ownerId, ownerId));

    return {
      totalBooks: Number(bookAgg?.totalBooks ?? 0),
      totalWords: Number(bookAgg?.totalWords ?? 0),
      totalChapters: Number(chapterAgg?.totalChapters ?? 0),
      serialBooks: Number(bookAgg?.serialBooks ?? 0),
      finishedBooks: Number(bookAgg?.finishedBooks ?? 0),
    };
  }

  /** GET /stats —— Python 版 1+8B 条查询，这里固定 3 条；按 UTC 日分桶 */
  async writingStats(ownerId: string, days = 7) {
    const safeDays = Math.max(1, Math.floor(days) || 7);

    // 1. 各书总字数与最后更新时间（streak 用）
    const bookRows = await this.db
      .select({ wordCount: books.wordCount, updatedAt: books.updatedAt })
      .from(books)
      .where(eq(books.ownerId, ownerId));
    const totalWordCount = bookRows.reduce((sum, b) => sum + b.wordCount, 0);

    // 2. 章节按 UTC 日聚合（一次覆盖 today + 最近 N 天）
    const today = utcDayKey(new Date());
    const windowStart = new Date(`${today}T00:00:00.000Z`);
    windowStart.setUTCDate(windowStart.getUTCDate() - (safeDays - 1));
    const dayRows = await this.db
      .select({
        day: sql<string>`to_char((${chapters.updatedAt} at time zone 'UTC')::date, 'YYYY-MM-DD')`,
        words: sql<number>`coalesce(sum(${chapters.wordCount}), 0)`,
      })
      .from(chapters)
      .innerJoin(books, eq(chapters.bookId, books.id))
      .where(and(eq(books.ownerId, ownerId), sql`${chapters.updatedAt} >= ${windowStart}`))
      .groupBy(sql`(${chapters.updatedAt} at time zone 'UTC')::date`);

    const byDay = new Map(dayRows.map((r) => [r.day, Number(r.words)]));
    const todayWordCount = byDay.get(today) ?? 0;

    const lastDays: Array<{ date: string; wordCount: number }> = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const d = new Date(`${today}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() - i);
      const key = utcDayKey(d);
      lastDays.push({ date: key, wordCount: byDay.get(key) ?? 0 });
    }

    // 3. streak：从今天起往回数，书籍 updated_at 落在该 UTC 日的连续天数
    const activeDays = new Set(bookRows.map((b) => utcDayKey(b.updatedAt)));
    let streakDays = 0;
    const cursor = new Date(`${today}T00:00:00.000Z`);
    while (activeDays.has(utcDayKey(cursor))) {
      streakDays += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }

    return {
      today_word_count: todayWordCount,
      total_word_count: totalWordCount,
      streak_days: streakDays,
      active_days: streakDays,
      last_7_days: lastDays,
      today,
    };
  }

  /**
   * POST /demo/seed —— 幂等：同标题书籍已存在则直接返回详情。
   * 整个种子过程单事务（Python 版靠一次 commit，这里更严格）。
   */
  async seedDemoBook(ownerId: string) {
    const existing = await this.db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.ownerId, ownerId), eq(books.title, DEMO_BOOK_TITLE)))
      .limit(1);
    if (existing[0]) {
      const detail = await this.getBookDetail(existing[0].id, ownerId);
      if (!detail) {
        throw new NotFoundException('作品不存在');
      }
      return detail;
    }

    const bookId = await this.db.transaction(async (tx) => {
      const [book] = await tx
        .insert(books)
        .values({
          title: DEMO_BOOK_TITLE,
          description: DEMO_DESCRIPTION,
          status: 'SERIAL',
          ownerId,
        })
        .returning({ id: books.id });

      let totalWords = 0;
      for (let order = 1; order <= DEMO_CHAPTERS.length; order++) {
        const chapterData = DEMO_CHAPTERS[order - 1];
        const chapterWords = wordCount(chapterData.content);
        totalWords += chapterWords;
        await tx.insert(chapters).values({
          title: chapterData.title,
          content: chapterData.content,
          wordCount: chapterWords,
          status: 'DRAFT',
          order,
          bookId: book.id,
        });
      }

      await tx.insert(outlines).values({
        title: DEMO_OUTLINE_TITLE,
        content: DEMO_OUTLINE,
        order: 1,
        bookId: book.id,
      });

      // Postgres 事务内 now() 恒为事务开始时间，多行 created_at 会全部相同，
      // 排序将退化（Python 侧每行有独立时间戳，展示顺序 = 插入顺序）。
      // 种子数据用显式递增的 createdAt 保持插入顺序稳定。
      const base = Date.now();
      await tx.insert(inspirations).values(
        DEMO_INSPIRATIONS.map((item, i) => ({
          title: item.title,
          content: item.content,
          tags: pyJsonDumpsList(item.tags),
          bookId: book.id,
          createdAt: new Date(base + i),
          updatedAt: new Date(base + i),
        })),
      );

      const insertedCharacters = await tx
        .insert(characters)
        .values(
          DEMO_CHARACTERS.map((c, i) => ({
            name: c.name,
            role: c.role,
            bio: c.bio,
            bookId: book.id,
            createdAt: new Date(base + i),
            updatedAt: new Date(base + i),
          })),
        )
        .returning({ id: characters.id, name: characters.name });
      const idByName = new Map(insertedCharacters.map((c) => [c.name, c.id]));

      const relationValues = DEMO_RELATIONS.flatMap(
        ([source, target, relationType, description, strength], i) => {
          const sourceId = idByName.get(source);
          const targetId = idByName.get(target);
          // Python 版查不到名字就跳过（continue），保持一致
          if (!sourceId || !targetId) {
            return [];
          }
          return [
            {
              sourceCharacterId: sourceId,
              targetCharacterId: targetId,
              relationType,
              description,
              strength,
              bookId: book.id,
              createdAt: new Date(base + i),
              updatedAt: new Date(base + i),
            },
          ];
        },
      );
      if (relationValues.length > 0) {
        await tx.insert(characterRelations).values(relationValues);
      }

      await tx.update(books).set({ wordCount: totalWords }).where(eq(books.id, book.id));
      return book.id;
    });

    const detail = await this.getBookDetail(bookId, ownerId);
    if (!detail) {
      throw new NotFoundException('作品不存在');
    }
    return detail;
  }
}

/** Date → 'YYYY-MM-DD'（UTC） */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
