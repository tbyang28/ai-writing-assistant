import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { CurrentUser } from '../core/current-user.decorator';
import { ParseUuidOr404Pipe } from '../core/parse-uuid-or-404.pipe';
import { ZodValidationPipe } from '../core/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DRIZZLE, type Database } from '../db/drizzle.module';
import { books, chapters, type Chapter, type User } from '../db/schema';
import { toChineseNumber } from '../shared/chinese-number';
import { wordCount } from '../shared/text';
import { chapterCreateSchema, chapterPublishSchema, chapterSaveSchema, chapterUpdateSchema } from './dto';
import { toChapterResponse } from './mappers';
import { RagService } from '../rag/rag.service';

/** 章节路由 —— 对应 routers/books.py 的 Chapters 段（/api 前缀之外的部分） */
@Controller()
@UseGuards(JwtAuthGuard)
export class ChaptersController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly rag: RagService,
  ) {}

  @Post('books/:bookId/chapters')
  @HttpCode(201)
  async create(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) bookId: string,
    @Body(new ZodValidationPipe(chapterCreateSchema)) body: { title: string | null | undefined },
    @CurrentUser() user: User,
  ) {
    const owned = await this.db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, bookId), eq(books.ownerId, user.id)))
      .limit(1);
    if (!owned[0]) {
      throw new NotFoundException('作品不存在');
    }

    // order = max(order) + 1
    const [agg] = await this.db
      .select({ maxOrder: sql<number | null>`max(${chapters.order})` })
      .from(chapters)
      .where(eq(chapters.bookId, bookId));
    const order = (agg?.maxOrder ?? 0) + 1;

    // Python 的 `data.title or f"第X章"`：None/'' 触发自动命名；
    // 但 pydantic 默认值是 '未命名章节'（字段缺省时），要区分 null 与 absent
    const title =
      body.title === undefined ? '未命名章节' : body.title || `第${toChineseNumber(order)}章`;

    const [chapter] = await this.db
      .insert(chapters)
      .values({ title, bookId, order })
      .returning();
    return toChapterResponse(chapter);
  }

  @Get('chapters/:chapterId')
  async get(
    @Param('chapterId', new ParseUuidOr404Pipe('章节不存在')) chapterId: string,
    @CurrentUser() user: User,
  ) {
    const chapter = await this.findOwnedChapter(chapterId, user.id);
    if (!chapter) {
      throw new NotFoundException('章节不存在');
    }
    return toChapterResponse(chapter);
  }

  /** PUT /chapters/save —— 编辑器保存（重算字数 + 书籍总字数） */
  @Put('chapters/save')
  async save(
    @Body(new ZodValidationPipe(chapterSaveSchema)) body: {
      chapter_id: string;
      title: string | null;
      content: string | null;
    },
    @CurrentUser() user: User,
  ) {
    const existing = await this.findOwnedChapter(body.chapter_id, user.id);
    if (!existing) {
      throw new NotFoundException('章节不存在');
    }

    const patch: Partial<typeof chapters.$inferInsert> = {};
    if (body.title != null) {
      patch.title = body.title;
    }
    if (body.content != null) {
      patch.content = body.content;
      patch.wordCount = wordCount(body.content);
    }
    if (Object.keys(patch).length > 0) {
      await this.db.update(chapters).set(patch).where(eq(chapters.id, body.chapter_id));
    }
    if (body.content != null) {
      // 自动索引：把章节内容向量化，供 RAG 语义搜索（内部逐块容错，不阻塞保存）
      await this.rag.indexChapter(body.chapter_id, body.content, existing.bookId);
    }

    // 无条件重算书籍总字数（Python 版同样如此，即使只改了标题）
    await this.recomputeBookWordCount(existing.bookId);

    const [fresh] = await this.db
      .select()
      .from(chapters)
      .where(eq(chapters.id, body.chapter_id))
      .limit(1);
    return toChapterResponse(fresh);
  }

  @Put('books/:bookId/chapters/:chapterId')
  async update(
    @Param('bookId', new ParseUuidOr404Pipe('章节不存在')) _bookId: string,
    @Param('chapterId', new ParseUuidOr404Pipe('章节不存在')) chapterId: string,
    @Body(new ZodValidationPipe(chapterUpdateSchema)) body: {
      title: string | null;
      content: string | null;
      status: string | null;
    },
    @CurrentUser() user: User,
  ) {
    const existing = await this.findOwnedChapterInBook(chapterId, _bookId, user.id);
    if (!existing) {
      throw new NotFoundException('章节不存在');
    }

    const patch: Partial<typeof chapters.$inferInsert> = {};
    if (body.title != null) {
      patch.title = body.title;
    }
    if (body.status != null) {
      patch.status = body.status;
    }
    // 注：Python 的 ChapterUpdate 虽含 content 字段，但 update_chapter 并不处理它
    if (Object.keys(patch).length > 0) {
      await this.db.update(chapters).set(patch).where(eq(chapters.id, chapterId));
    }

    const [fresh] = await this.db.select().from(chapters).where(eq(chapters.id, chapterId)).limit(1);
    return toChapterResponse(fresh);
  }

  @Delete('books/:bookId/chapters/:chapterId')
  @HttpCode(204)
  async remove(
    @Param('bookId', new ParseUuidOr404Pipe('章节不存在')) bookId: string,
    @Param('chapterId', new ParseUuidOr404Pipe('章节不存在')) chapterId: string,
    @CurrentUser() user: User,
  ) {
    const existing = await this.findOwnedChapterInBook(chapterId, bookId, user.id);
    if (!existing) {
      throw new NotFoundException('章节不存在');
    }
    // FK 级联会带走 document_chunks（Python 版 SQLite 无 FK，会留孤儿行——这是修复）
    await this.db.delete(chapters).where(eq(chapters.id, chapterId));
  }

  @Post('chapters/publish')
  @HttpCode(200)
  async publish(
    @Body(new ZodValidationPipe(chapterPublishSchema)) body: { chapter_id?: string },
    @CurrentUser() user: User,
  ) {
    // Python 版接收裸 dict，chapter_id 缺失时查不到行 → 404（不是 400），保持一致
    const existing = body.chapter_id
      ? await this.findOwnedChapter(body.chapter_id, user.id)
      : null;
    if (!existing) {
      throw new NotFoundException('章节不存在');
    }
    await this.db
      .update(chapters)
      .set({ status: 'PUBLISHED' })
      .where(eq(chapters.id, existing.id));
    const [fresh] = await this.db
      .select()
      .from(chapters)
      .where(eq(chapters.id, existing.id))
      .limit(1);
    return toChapterResponse(fresh);
  }

  /** join books 校验归属（对应 Python 的 Chapter JOIN Book 查询） */
  private async findOwnedChapter(chapterId: string, ownerId: string): Promise<Chapter | null> {
    const rows = await this.db
      .select({ chapter: chapters })
      .from(chapters)
      .innerJoin(books, eq(chapters.bookId, books.id))
      .where(and(eq(chapters.id, chapterId), eq(books.ownerId, ownerId)))
      .limit(1);
    return rows[0]?.chapter ?? null;
  }

  private async findOwnedChapterInBook(
    chapterId: string,
    bookId: string,
    ownerId: string,
  ): Promise<Chapter | null> {
    const rows = await this.db
      .select({ chapter: chapters })
      .from(chapters)
      .innerJoin(books, eq(chapters.bookId, books.id))
      .where(
        and(
          eq(chapters.id, chapterId),
          eq(chapters.bookId, bookId),
          eq(books.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0]?.chapter ?? null;
  }

  private async recomputeBookWordCount(bookId: string): Promise<void> {
    const [agg] = await this.db
      .select({ total: sql<number>`coalesce(sum(${chapters.wordCount}), 0)` })
      .from(chapters)
      .where(eq(chapters.bookId, bookId));
    await this.db
      .update(books)
      .set({ wordCount: Number(agg?.total ?? 0) })
      .where(eq(books.id, bookId));
  }
}
