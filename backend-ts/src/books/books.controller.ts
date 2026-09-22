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
  Query,
  UseGuards,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { CurrentUser } from '../core/current-user.decorator';
import { ParseUuidOr404Pipe } from '../core/parse-uuid-or-404.pipe';
import { ZodValidationPipe } from '../core/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DRIZZLE, type Database } from '../db/drizzle.module';
import { books, type User } from '../db/schema';
import { BooksService } from './books.service';
import { bookCreateSchema, bookUpdateSchema } from './dto';
import { toBookListPayload } from './mappers';

/**
 * 书籍 CRUD + 统计 + demo 种子 —— 对应 routers/books.py 的 Books 段。
 *
 * 路由声明顺序是契约：`books/stats` 必须先于 `books/:id` 注册，
 * 否则 Express 会把 "stats" 当成 :id 参数（本控制器内已按此排列，勿调整顺序）。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class BooksController {
  constructor(
    private readonly booksService: BooksService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  @Get('books')
  async list(@CurrentUser() user: User) {
    return this.booksService.listBooks(user.id);
  }

  @Get('books/stats')
  async bookStats(@CurrentUser() user: User) {
    return this.booksService.bookStats(user.id);
  }

  @Get('stats')
  async writingStats(@CurrentUser() user: User, @Query('days') days?: string) {
    const parsed = days ? Number(days) : 7;
    return this.booksService.writingStats(user.id, Number.isFinite(parsed) ? parsed : 7);
  }

  @Get('books/:id')
  async getBook(@Param('id', new ParseUuidOr404Pipe('作品不存在')) id: string, @CurrentUser() user: User) {
    const detail = await this.booksService.getBookDetail(id, user.id);
    if (!detail) {
      throw new NotFoundException('作品不存在');
    }
    return detail;
  }

  @Post('books')
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(bookCreateSchema)) body: {
      title: string;
      description: string | null;
      cover: string | null;
    },
    @CurrentUser() user: User,
  ) {
    const [book] = await this.db
      .insert(books)
      .values({
        title: body.title,
        description: body.description ?? '',
        cover: body.cover ?? '',
        ownerId: user.id,
      })
      .returning();
    return toBookListPayload(book);
  }

  @Put('books/:id')
  async update(
    @Param('id', new ParseUuidOr404Pipe('作品不存在')) id: string,
    @Body(new ZodValidationPipe(bookUpdateSchema)) body: {
      title: string | null;
      description: string | null;
      cover: string | null;
      status: string | null;
    },
    @CurrentUser() user: User,
  ) {
    const existing = await this.db
      .select()
      .from(books)
      .where(and(eq(books.id, id), eq(books.ownerId, user.id)))
      .limit(1);
    if (!existing[0]) {
      throw new NotFoundException('作品不存在');
    }

    const patch: Partial<typeof books.$inferInsert> = {};
    if (body.title != null) {
      patch.title = body.title;
    }
    if (body.description != null) {
      patch.description = body.description;
    }
    if (body.cover != null) {
      patch.cover = body.cover;
    }
    if (body.status != null) {
      patch.status = body.status;
    }
    // 空 patch 不发 UPDATE（SQLAlchemy 同语义：无字段变更不更新，updated_at 不动）
    let book = existing[0];
    if (Object.keys(patch).length > 0) {
      const [updated] = await this.db.update(books).set(patch).where(eq(books.id, id)).returning();
      book = updated;
    }
    return toBookListPayload(book);
  }

  @Delete('books/:id')
  @HttpCode(204)
  async remove(@Param('id', new ParseUuidOr404Pipe('作品不存在')) id: string, @CurrentUser() user: User) {
    const deleted = await this.db
      .delete(books)
      .where(and(eq(books.id, id), eq(books.ownerId, user.id)))
      .returning({ id: books.id });
    if (!deleted[0]) {
      throw new NotFoundException('作品不存在');
    }
  }

  /** POST /api/demo/seed —— 200（幂等：重复调用返回已存在的演示书） */
  @Post('demo/seed')
  @HttpCode(200)
  async seedDemo(@CurrentUser() user: User) {
    return this.booksService.seedDemoBook(user.id);
  }
}
