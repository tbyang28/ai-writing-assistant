/**
 * SQLite → PostgreSQL 一次性数据迁移 —— Phase 7。
 *
 * 用法：
 *   npx tsx tools/import-sqlite.ts <sqlite 文件> [database-url]
 *   例：npx tsx tools/import-sqlite.ts ../backend/writing_platform.db \
 *         postgres://postgres:postgres@localhost:5435/ai_writing
 *
 * 迁移规则（对应 Python 版的真实存储形态）：
 *   - 时间：SQLite 里是 Python utcnow 写入的 naive UTC 字符串
 *    （"2026-05-01 12:00:00.123456"）→ 补 T 和 Z 转 timestamptz。
 *   - 密码：$2b$ bcrypt 哈希原样照搬（bcryptjs 能验）。
 *   - tags：JSON 字符串原样照搬（契约就是字符串，ensure_ascii 形态也保留）。
 *   - embedding：JSON 字符串 → number[] → pgvector vector(1024) 列；
 *     解析失败或维度 != 1024 → 置 NULL（Python 版检索时本来就跳过空向量）。
 *   - 孤儿行：Python 版 SQLite 没开 FK 约束，可能存在指向已删书/章的行；
 *     PG 侧是真级联，插入前按父表过滤并统计跳过数。
 *   - 幂等：主键冲突跳过（onConflictDoNothing），可安全重跑。
 *
 * 读 SQLite 用 Node 内置的 node:sqlite（≥22.5）—— 不引 better-sqlite3，
 * 因为它是 drizzle-orm 的 peer 依赖，会被 npm 提升进生产依赖、
 * 在 alpine 镜像里触发 node-gyp 编译失败。
 */
import { DatabaseSync } from 'node:sqlite';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from '../src/db/schema';

const sqlitePath = process.argv[2];
const databaseUrl =
  process.argv[3] ?? 'postgres://postgres:postgres@localhost:5435/ai_writing';

if (!sqlitePath) {
  console.error('用法: npx tsx tools/import-sqlite.ts <sqlite 文件> [database-url]');
  process.exit(1);
}

/** naive UTC 字符串 → Date（非法/空 → 现在） */
function toDate(value: unknown): Date {
  if (typeof value === 'string' && value) {
    const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return new Date();
}

function toInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

/** embedding JSON → number[]；坏数据/维度不对 → null */
function toEmbedding(value: unknown): number[] | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  try {
    const vec = JSON.parse(value);
    if (!Array.isArray(vec) || vec.length !== 1024) {
      return null;
    }
    const nums = vec.map(Number);
    return nums.every((n) => Number.isFinite(n)) ? nums : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

  const all = sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ?');
  const tableNames = new Set(
    (all.all('table') as Array<{ name: string }>).map((t) => t.name),
  );
  const rows = <T>(table: string): T[] =>
    tableNames.has(table) ? (sqlite.prepare(`SELECT * FROM ${table}`).all() as T[]) : [];

  const stats: Array<[string, number, number]> = []; // [表, 读取, 写入]

  // ---------- 按依赖顺序导入 ----------
  const users = rows<Record<string, unknown>>('users');
  const userIds = new Set(users.map((u) => String(u.id)));
  let written = await db
    .insert(schema.users)
    .values(
      users.map((u) => ({
        id: String(u.id),
        email: toStr(u.email, `unknown-${u.id}@invalid`),
        password: toStr(u.password),
        name: toStr(u.name),
        avatar: toStr(u.avatar),
        createdAt: toDate(u.created_at),
        updatedAt: toDate(u.updated_at),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.users.id });
  stats.push(['users', users.length, written.length]);

  const books = rows<Record<string, unknown>>('books').filter((b) =>
    userIds.has(String(b.owner_id)),
  );
  const bookIds = new Set(books.map((b) => String(b.id)));
  written = await db
    .insert(schema.books)
    .values(
      books.map((b) => ({
        id: String(b.id),
        title: toStr(b.title, '未命名作品'),
        cover: toStr(b.cover),
        description: toStr(b.description),
        status: toStr(b.status, 'DRAFT'),
        wordCount: toInt(b.word_count),
        ownerId: String(b.owner_id),
        createdAt: toDate(b.created_at),
        updatedAt: toDate(b.updated_at),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.books.id });
  stats.push(['books', rows('books').length, written.length]);

  const chapters = rows<Record<string, unknown>>('chapters').filter((c) =>
    bookIds.has(String(c.book_id)),
  );
  const chapterIds = new Set(chapters.map((c) => String(c.id)));
  written = await db
    .insert(schema.chapters)
    .values(
      chapters.map((c) => ({
        id: String(c.id),
        title: toStr(c.title, '未命名章节'),
        content: toStr(c.content),
        wordCount: toInt(c.word_count),
        status: toStr(c.status, 'DRAFT'),
        order: toInt(c.order),
        bookId: String(c.book_id),
        createdAt: toDate(c.created_at),
        updatedAt: toDate(c.updated_at),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.chapters.id });
  stats.push(['chapters', rows('chapters').length, written.length]);

  const outlines = rows<Record<string, unknown>>('outlines').filter((o) =>
    bookIds.has(String(o.book_id)),
  );
  written = await db
    .insert(schema.outlines)
    .values(
      outlines.map((o) => ({
        id: String(o.id),
        title: toStr(o.title, '未命名大纲'),
        content: toStr(o.content),
        order: toInt(o.order),
        bookId: String(o.book_id),
        createdAt: toDate(o.created_at),
        updatedAt: toDate(o.updated_at),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.outlines.id });
  stats.push(['outlines', rows('outlines').length, written.length]);

  const characters = rows<Record<string, unknown>>('characters').filter((c) =>
    bookIds.has(String(c.book_id)),
  );
  const characterIds = new Set(characters.map((c) => String(c.id)));
  written = await db
    .insert(schema.characters)
    .values(
      characters.map((c) => ({
        id: String(c.id),
        name: toStr(c.name, '未知'),
        role: toStr(c.role),
        avatar: toStr(c.avatar),
        bio: toStr(c.bio),
        bookId: String(c.book_id),
        createdAt: toDate(c.created_at),
        updatedAt: toDate(c.updated_at),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.characters.id });
  stats.push(['characters', rows('characters').length, written.length]);

  const relations = rows<Record<string, unknown>>('character_relations').filter(
    (r) =>
      bookIds.has(String(r.book_id)) &&
      characterIds.has(String(r.source_character_id)) &&
      characterIds.has(String(r.target_character_id)),
  );
  written = await db
    .insert(schema.characterRelations)
    .values(
      relations.map((r) => ({
        id: String(r.id),
        sourceCharacterId: String(r.source_character_id),
        targetCharacterId: String(r.target_character_id),
        relationType: toStr(r.relation_type, 'ally'),
        description: toStr(r.description),
        strength: toInt(r.strength, 2),
        bookId: String(r.book_id),
        createdAt: toDate(r.created_at),
        updatedAt: toDate(r.updated_at),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.characterRelations.id });
  stats.push(['character_relations', rows('character_relations').length, written.length]);

  const inspirations = rows<Record<string, unknown>>('inspirations').filter((i) =>
    bookIds.has(String(i.book_id)),
  );
  written = await db
    .insert(schema.inspirations)
    .values(
      inspirations.map((i) => ({
        id: String(i.id),
        title: toStr(i.title, '未命名灵感'),
        content: toStr(i.content),
        tags: toStr(i.tags, '[]'),
        bookId: String(i.book_id),
        createdAt: toDate(i.created_at),
        updatedAt: toDate(i.updated_at),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.inspirations.id });
  stats.push(['inspirations', rows('inspirations').length, written.length]);

  // 孤儿向量块：章节已删但块还在（Python 版无 FK 的遗留）→ 只迁移章节仍存在的
  const chunks = rows<Record<string, unknown>>('document_chunks').filter(
    (d) =>
      bookIds.has(String(d.book_id)) &&
      (d.chapter_id == null || chapterIds.has(String(d.chapter_id))),
  );
  written = await db
    .insert(schema.documentChunks)
    .values(
      chunks.map((d) => ({
        id: String(d.id),
        bookId: String(d.book_id),
        chapterId: d.chapter_id == null ? null : String(d.chapter_id),
        content: toStr(d.content),
        chunkOrder: toInt(d.chunk_order),
        embedding: toEmbedding(d.embedding),
        createdAt: toDate(d.created_at),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.documentChunks.id });
  stats.push(['document_chunks', rows('document_chunks').length, written.length]);

  // ---------- 报告 ----------
  console.log('\n迁移结果（读取 / 写入，差值 = 冲突跳过 + 孤儿行过滤）：');
  for (const [table, read, wrote] of stats) {
    const skipped = read - wrote;
    const mark = skipped > 0 ? `  （跳过 ${skipped}）` : '';
    console.log(`  ${table.padEnd(22)} ${String(read).padStart(5)} → ${String(wrote).padStart(5)}${mark}`);
  }

  sqlite.close();
  await pool.end();
}

main().catch((e) => {
  console.error('迁移失败：', e);
  process.exit(1);
});
