import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { CurrentUser } from '../core/current-user.decorator';
import { ParseUuidOr404Pipe } from '../core/parse-uuid-or-404.pipe';
import { ZodValidationPipe } from '../core/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DRIZZLE, type Database } from '../db/drizzle.module';
import { books, characters, characterRelations, inspirations, outlines, type User } from '../db/schema';
import { pyJsonDumpsAsciiList } from '../shared/text';
import {
  characterCreateSchema,
  characterRelationCreateSchema,
  inspirationCreateSchema,
  outlineCreateSchema,
} from './dto';
import {
  toCharacterRelationResponse,
  toCharacterResponse,
  toInspirationResponse,
  toOutlineResponse,
} from './mappers';

/**
 * 设定库（大纲/角色/关系/灵感）—— 对应 routers/books.py 的
 * Outlines / Characters / CharacterRelations / Inspirations 段。
 *
 * 刻意修复（Python 版的 3 处越权写洞）：create_outline / create_character /
 * create_inspiration 原版不校验书籍归属，任何登录用户可往他人书里写数据；
 * TS 版统一按 `id AND owner_id` 查询 → 404 作品不存在。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class LibraryController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // ===================== Outlines =====================

  @Get('books/:bookId/outlines')
  async listOutlines(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) _bookId: string,
    @CurrentUser() user: User,
  ) {
    // Python 版对不存在的书也返回 []（join 落空），保持一致
    const rows = await this.db
      .select({ outline: outlines })
      .from(outlines)
      .innerJoin(books, eq(outlines.bookId, books.id))
      .where(and(eq(outlines.bookId, _bookId), eq(books.ownerId, user.id)))
      .orderBy(outlines.order);
    return rows.map((r) => toOutlineResponse(r.outline));
  }

  @Post('books/:bookId/outlines')
  @HttpCode(201)
  async createOutline(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) bookId: string,
    @Body(new ZodValidationPipe(outlineCreateSchema)) body: { title: string; content: string | null },
    @CurrentUser() user: User,
  ) {
    await this.assertOwnedBook(bookId, user.id); // 越权修复：Python 版无此检查

    const [agg] = await this.db
      .select({ maxOrder: sql<number | null>`max(${outlines.order})` })
      .from(outlines)
      .where(eq(outlines.bookId, bookId));

    const [outline] = await this.db
      .insert(outlines)
      .values({
        title: body.title,
        content: body.content ?? '',
        bookId,
        order: (agg?.maxOrder ?? 0) + 1,
      })
      .returning();
    return toOutlineResponse(outline);
  }

  // ===================== Characters =====================

  @Get('books/:bookId/characters')
  async listCharacters(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) _bookId: string,
    @CurrentUser() user: User,
  ) {
    // Python 版此列表无 order_by（实际为插入序）；显式按 created_at asc
    const rows = await this.db
      .select({ character: characters })
      .from(characters)
      .innerJoin(books, eq(characters.bookId, books.id))
      .where(and(eq(characters.bookId, _bookId), eq(books.ownerId, user.id)))
      .orderBy(characters.createdAt, characters.id);
    return rows.map((r) => toCharacterResponse(r.character));
  }

  @Post('books/:bookId/characters')
  @HttpCode(201)
  async createCharacter(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) bookId: string,
    @Body(new ZodValidationPipe(characterCreateSchema)) body: {
      name: string;
      role: string | null;
      bio: string | null;
    },
    @CurrentUser() user: User,
  ) {
    await this.assertOwnedBook(bookId, user.id); // 越权修复：Python 版无此检查

    const [character] = await this.db
      .insert(characters)
      .values({
        name: body.name,
        role: body.role ?? '',
        bio: body.bio ?? '',
        bookId,
      })
      .returning();
    return toCharacterResponse(character);
  }

  // ===================== Character Relations =====================

  @Get('books/:bookId/character-relations')
  async listRelations(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) _bookId: string,
    @CurrentUser() user: User,
  ) {
    const rows = await this.db
      .select({ relation: characterRelations })
      .from(characterRelations)
      .innerJoin(books, eq(characterRelations.bookId, books.id))
      .where(and(eq(characterRelations.bookId, _bookId), eq(books.ownerId, user.id)))
      .orderBy(desc(characterRelations.createdAt), desc(characterRelations.id));
    return rows.map((r) => toCharacterRelationResponse(r.relation));
  }

  @Post('books/:bookId/character-relations')
  @HttpCode(201)
  async createRelation(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) bookId: string,
    @Body(new ZodValidationPipe(characterRelationCreateSchema)) body: {
      source_character_id: string;
      target_character_id: string;
      relation_type: string;
      description: string | null;
      strength: number;
    },
    @CurrentUser() user: User,
  ) {
    if (body.source_character_id === body.target_character_id) {
      throw new BadRequestException('不能创建角色自身关系');
    }

    await this.assertOwnedBook(bookId, user.id);

    // 两个角色都必须属于这本书
    const found = await this.db
      .select({ id: characters.id })
      .from(characters)
      .where(
        and(
          eq(characters.bookId, bookId),
          inArray(characters.id, [body.source_character_id, body.target_character_id]),
        ),
      );
    if (found.length !== 2) {
      throw new BadRequestException('关系中的角色不存在');
    }

    const [relation] = await this.db
      .insert(characterRelations)
      .values({
        sourceCharacterId: body.source_character_id,
        targetCharacterId: body.target_character_id,
        relationType: body.relation_type,
        description: body.description ?? '',
        strength: Math.max(1, Math.min(body.strength, 5)),
        bookId,
      })
      .returning();
    return toCharacterRelationResponse(relation);
  }

  @Delete('books/:bookId/character-relations/:relationId')
  @HttpCode(204)
  async deleteRelation(
    @Param('bookId', new ParseUuidOr404Pipe('关系不存在')) bookId: string,
    @Param('relationId', new ParseUuidOr404Pipe('关系不存在')) relationId: string,
    @CurrentUser() user: User,
  ) {
    const found = await this.db
      .select({ id: characterRelations.id })
      .from(characterRelations)
      .innerJoin(books, eq(characterRelations.bookId, books.id))
      .where(
        and(
          eq(characterRelations.id, relationId),
          eq(characterRelations.bookId, bookId),
          eq(books.ownerId, user.id),
        ),
      )
      .limit(1);
    if (!found[0]) {
      throw new NotFoundException('关系不存在');
    }
    await this.db.delete(characterRelations).where(eq(characterRelations.id, relationId));
  }

  // ===================== Inspirations =====================

  @Get('books/:bookId/inspirations')
  async listInspirations(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) _bookId: string,
    @CurrentUser() user: User,
  ) {
    const rows = await this.db
      .select({ inspiration: inspirations })
      .from(inspirations)
      .innerJoin(books, eq(inspirations.bookId, books.id))
      .where(and(eq(inspirations.bookId, _bookId), eq(books.ownerId, user.id)))
      .orderBy(desc(inspirations.createdAt), desc(inspirations.id));
    return rows.map((r) => toInspirationResponse(r.inspiration));
  }

  @Post('books/:bookId/inspirations')
  @HttpCode(201)
  async createInspiration(
    @Param('bookId', new ParseUuidOr404Pipe('作品不存在')) bookId: string,
    @Body(new ZodValidationPipe(inspirationCreateSchema)) body: {
      title: string;
      content: string;
      tags: string[] | null;
    },
    @CurrentUser() user: User,
  ) {
    await this.assertOwnedBook(bookId, user.id); // 越权修复：Python 版无此检查

    // Python 侧 json.dumps(data.tags or [])：默认 ensure_ascii=True（中文转 \uXXXX）
    const [inspiration] = await this.db
      .insert(inspirations)
      .values({
        title: body.title,
        content: body.content,
        tags: pyJsonDumpsAsciiList(body.tags ?? []),
        bookId,
      })
      .returning();
    return toInspirationResponse(inspiration);
  }

  private async assertOwnedBook(bookId: string, ownerId: string): Promise<void> {
    const found = await this.db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, bookId), eq(books.ownerId, ownerId)))
      .limit(1);
    if (!found[0]) {
      throw new NotFoundException('作品不存在');
    }
  }
}
