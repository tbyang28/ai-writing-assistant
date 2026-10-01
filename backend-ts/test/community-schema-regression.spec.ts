import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

import { randomUUID } from 'node:crypto';
import { AuthService, toUserResponse } from '../src/auth/auth.service';
import { schema } from '../src/db/schema';

// This suite owns a separate database and never truncates the shared E2E database.
const databaseUrl = 'postgres://postgres:postgres@localhost:5434/ai_writing_community_schema_check';
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const db = drizzle(pool, { schema });
const migrationsFolder = join(process.cwd(), 'drizzle');
const firstId = '12345678-0000-4000-8000-000000000001';
const secondId = '12345678-0000-4000-8000-000000000002';

beforeAll(async () => {
  const admin = new Pool({ connectionString: databaseUrl.replace(/\/ai_writing_community_schema_check$/, '/postgres') });
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['ai_writing_community_schema_check']);
    if (!exists.rowCount) await admin.query('CREATE DATABASE ai_writing_community_schema_check');
  } finally {
    await admin.end();
  }
});

beforeEach(async () => {
  vi.mocked(randomUUID).mockReset();
  vi.mocked(randomUUID).mockImplementation(() => crypto.randomUUID());
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public');
});

afterAll(async () => { await pool.end(); });

async function migrateThrough(count: number): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'community-migrations-'));
  try {
    await mkdir(join(folder, 'meta'));
    const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
    journal.entries = journal.entries.slice(0, count);
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) {
      await writeFile(join(folder, `${entry.tag}.sql`), await readFile(join(migrationsFolder, `${entry.tag}.sql`)));
    }
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function authService(): AuthService {
  return new AuthService(new ConfigService({ SECRET_KEY: 'test-secret-key', ACCESS_TOKEN_EXPIRE_MINUTES: 1440 }), db);
}

describe('community schema compatibility regressions', () => {
  it('migrates users sharing a UUID prefix without losing old private content', async () => {
    await migrateThrough(1);
    await pool.query('INSERT INTO users (id, email, password, name) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)',
      [firstId, 'old-one@example.com', 'original-hash', '旧作者', secondId, 'old-two@example.com']);
    await pool.query("INSERT INTO books (id, title, owner_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', '旧作品', $1)", [firstId]);
    await pool.query("INSERT INTO chapters (title, content, book_id) VALUES ('草稿章', '原有私密正文', 'aaaaaaaa-0000-4000-8000-000000000001')");

    await migrate(db, { migrationsFolder });
    await migrate(db, { migrationsFolder });
    const users = await pool.query('SELECT username, password FROM users ORDER BY id');
    expect(users.rows).toEqual([
      { username: '12345678000040008000000000000001', password: 'original-hash' },
      { username: '12345678000040008000000000000002', password: 'original-hash' },
    ]);
    const books = await pool.query('SELECT title, visibility FROM books');
    expect(books.rows).toEqual([{ title: '旧作品', visibility: 'PRIVATE' }]);
    const chapters = await pool.query('SELECT content, status FROM chapters');
    expect(chapters.rows).toEqual([{ content: '原有私密正文', status: 'DRAFT' }]);
  });

  it('upgrades an already applied community migration without changing usernames or losing orphan replies', async () => {
    await migrateThrough(2);
    await pool.query('INSERT INTO users (id, email, password, username) VALUES ($1, $2, $3, $4)',
      [firstId, 'legacy@example.com', 'x', 'author-12345678']);
    await pool.query("INSERT INTO books (id, title, owner_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', '作品', $1)", [firstId]);
    await pool.query('INSERT INTO comments (book_id, author_id, parent_id, content) VALUES ($1, $2, $3, $4)',
      ['aaaaaaaa-0000-4000-8000-000000000001', firstId, 'bbbbbbbb-0000-4000-8000-000000000099', '旧孤儿回复']);
    await migrate(db, { migrationsFolder });
    expect((await pool.query('SELECT username FROM users')).rows).toEqual([{ username: 'author-12345678' }]);
    expect((await pool.query('SELECT parent_id, content FROM comments')).rows).toEqual([{ parent_id: null, content: '旧孤儿回复' }]);
  });

  it('rejects nonexistent reply parents and preserves replies when a parent author is deleted', async () => {
    await migrate(db, { migrationsFolder });
    await pool.query('INSERT INTO users (id, email, password, username) VALUES ($1, $2, $3, $4), ($5, $6, $3, $7)',
      [firstId, 'parent@example.com', 'x', 'parent', secondId, 'reply@example.com', 'reply']);
    await pool.query("INSERT INTO books (id, title, owner_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', '作品', $1)", [secondId]);
    const bookId = 'aaaaaaaa-0000-4000-8000-000000000001';
    await expect(pool.query('INSERT INTO comments (book_id, author_id, parent_id, content) VALUES ($1, $2, $3, $4)',
      [bookId, secondId, 'bbbbbbbb-0000-4000-8000-000000000099', '无效回复'])).rejects.toMatchObject({ code: '23503' });
    const parent = await pool.query('INSERT INTO comments (book_id, author_id, content) VALUES ($1, $2, $3) RETURNING id', [bookId, firstId, '父评论']);
    await pool.query('INSERT INTO comments (book_id, author_id, parent_id, content) VALUES ($1, $2, $3, $4)', [bookId, secondId, parent.rows[0].id, '保留的回复']);
    await pool.query('UPDATE comments SET deleted_at = now() WHERE id = $1', [parent.rows[0].id]);
    expect((await pool.query('SELECT parent_id FROM comments WHERE author_id = $1', [secondId])).rows[0].parent_id).toBe(parent.rows[0].id);
    await pool.query('DELETE FROM users WHERE id = $1', [firstId]);
    expect((await pool.query('SELECT parent_id, content FROM comments')).rows).toEqual([{ parent_id: null, content: '保留的回复' }]);
  });

  it('retries a generated username collision and returns a valid password and public profile', async () => {
    await migrate(db, { migrationsFolder });
    const service = authService();
    vi.mocked(randomUUID).mockReturnValueOnce(firstId);
    const original = await service.createUser('first@example.com', 'secret', '作者');
    vi.mocked(randomUUID).mockReturnValueOnce(firstId).mockReturnValueOnce(secondId);
    const created = await service.createUser('second@example.com', 'secret', '作者');
    expect(created.username).not.toBe(original.username);
    expect(created.username.length).toBeLessThanOrEqual(32);
    expect(await service.verifyPassword('secret', created.password)).toBe(true);
    expect(toUserResponse(created)).toMatchObject({ username: created.username, bio: '' });
    expect(toUserResponse(created)).not.toHaveProperty('password');
    expect((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count).toBe(2);
  });

  it('propagates email conflicts instead of retrying them as username collisions', async () => {
    await migrate(db, { migrationsFolder });
    const service = authService();
    await service.createUser('same@example.com', 'secret', '作者');
    await expect(service.createUser('same@example.com', 'secret', '其他作者')).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'users_email_unique' },
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count).toBe(1);
  });
});
