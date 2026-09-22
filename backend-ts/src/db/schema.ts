import { index, integer, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';

/**
 * 8 张表 —— 逐字段镜像 Python 侧 models/*。
 *
 * 相对 Python 版的刻意升级（契约不变，行为修复）：
 *   1. 真 FK + ON DELETE CASCADE：SQLite 版无 FK 约束，删章节会孤儿化
 *      document_chunks 行；PG 全部级联删除。
 *   2. embedding 用 pgvector vector(1024) 列，替代「JSON 字符串存 TEXT」。
 *   3. timestamptz 替代 naive datetime。
 * 契约保留：tags 存 JSON 字符串（API 返回 string）；status/relation_type 纯文本。
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  name: text('name').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  ...timestamps,
});

export const books = pgTable('books', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  cover: text('cover').notNull().default(''),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('DRAFT'), // DRAFT | SERIAL | FINISHED
  wordCount: integer('word_count').notNull().default(0),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ...timestamps,
});

export const chapters = pgTable('chapters', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull().default('未命名章节'),
  content: text('content').notNull().default(''),
  wordCount: integer('word_count').notNull().default(0),
  status: text('status').notNull().default('DRAFT'), // DRAFT | PUBLISHED
  order: integer('order').notNull().default(0),
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.id, { onDelete: 'cascade' }),
  ...timestamps,
});

export const outlines = pgTable('outlines', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  order: integer('order').notNull().default(0),
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.id, { onDelete: 'cascade' }),
  ...timestamps,
});

export const characters = pgTable('characters', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  role: text('role').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  bio: text('bio').notNull().default(''),
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.id, { onDelete: 'cascade' }),
  ...timestamps,
});

export const characterRelations = pgTable('character_relations', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceCharacterId: uuid('source_character_id')
    .notNull()
    .references(() => characters.id, { onDelete: 'cascade' }),
  targetCharacterId: uuid('target_character_id')
    .notNull()
    .references(() => characters.id, { onDelete: 'cascade' }),
  relationType: text('relation_type').notNull().default('ally'), // ally | rival | mentor | complex
  description: text('description').notNull().default(''),
  strength: integer('strength').notNull().default(2), // 1-5
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.id, { onDelete: 'cascade' }),
  ...timestamps,
});

export const inspirations = pgTable('inspirations', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  tags: text('tags').notNull().default('[]'), // JSON 数组字符串（契约：API 返回 string）
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.id, { onDelete: 'cascade' }),
  ...timestamps,
});

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    chunkOrder: integer('chunk_order').notNull().default(0),
    embedding: vector('embedding', { dimensions: 1024 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('document_chunks_book_id_idx').on(table.bookId)],
);

/** 传给 drizzle() 的 schema 集合（关系 API / 迁移器都要用） */
export const schema = {
  users,
  books,
  chapters,
  outlines,
  characters,
  characterRelations,
  inspirations,
  documentChunks,
};

export type User = typeof users.$inferSelect;
export type Book = typeof books.$inferSelect;
export type Chapter = typeof chapters.$inferSelect;
export type Outline = typeof outlines.$inferSelect;
export type Character = typeof characters.$inferSelect;
export type CharacterRelation = typeof characterRelations.$inferSelect;
export type Inspiration = typeof inspirations.$inferSelect;
export type DocumentChunk = typeof documentChunks.$inferSelect;
