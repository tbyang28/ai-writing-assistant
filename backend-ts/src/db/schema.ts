import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

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
  username: text('username').notNull(),
  bio: text('bio').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  ...timestamps,
}, (table) => [uniqueIndex('users_username_unique').on(table.username)]);

export const books = pgTable('books', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  cover: text('cover').notNull().default(''),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('DRAFT'), // DRAFT | SERIAL | FINISHED
  wordCount: integer('word_count').notNull().default(0),
  visibility: text('visibility').notNull().default('PRIVATE'), // PRIVATE | PUBLIC
  genre: text('genre').notNull().default(''),
  tags: text('tags').notNull().default('[]'),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  readCount: integer('read_count').notNull().default(0),
  likeCount: integer('like_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  allowComments: boolean('allow_comments').notNull().default(true),
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

export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followingId: uuid('following_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followingId] }),
    index('follows_following_id_idx').on(table.followingId),
  ],
);

export const bookLikes = pgTable(
  'book_likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId, table.bookId] }), index('book_likes_book_id_idx').on(table.bookId)],
);

export const bookFavorites = pgTable(
  'book_favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.bookId] }),
    index('book_favorites_user_id_idx').on(table.userId),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    content: text('content').notNull(),
    isPinned: boolean('is_pinned').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    index('comments_book_id_idx').on(table.bookId, table.createdAt),
    index('comments_chapter_id_idx').on(table.chapterId, table.createdAt),
  ],
);

export const readingProgress = pgTable(
  'reading_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId, table.bookId] })],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    bookId: uuid('book_id').references(() => books.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [index('notifications_recipient_id_idx').on(table.recipientId, table.createdAt)],
);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('OPEN'),
    ...timestamps,
  },
  (table) => [index('reports_target_idx').on(table.targetType, table.targetId)],
);

export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.blockerId, table.blockedId] })],
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
  follows,
  bookLikes,
  bookFavorites,
  comments,
  readingProgress,
  notifications,
  reports,
  blocks,
};

export type User = typeof users.$inferSelect;
export type Book = typeof books.$inferSelect;
export type Chapter = typeof chapters.$inferSelect;
export type Outline = typeof outlines.$inferSelect;
export type Character = typeof characters.$inferSelect;
export type CharacterRelation = typeof characterRelations.$inferSelect;
export type Inspiration = typeof inspirations.$inferSelect;
export type DocumentChunk = typeof documentChunks.$inferSelect;
export type Follow = typeof follows.$inferSelect;
export type BookLike = typeof bookLikes.$inferSelect;
export type BookFavorite = typeof bookFavorites.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type ReadingProgress = typeof readingProgress.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Block = typeof blocks.$inferSelect;
