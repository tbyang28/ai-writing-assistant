import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { schema } from '../src/db/schema';

/**
 * Vitest globalSetup —— 对应 Python tests/conftest.py 的建表职责。
 * 在全部测试文件启动前，对测试库（TEST_DATABASE_URL）执行一次 drizzle 迁移。
 * 迁移文件头部已手工预置 CREATE EXTENSION vector（见 drizzle/0000_*.sql）。
 *
 * 注意：vitest 3 的 test.env 只注入测试 worker，globalSetup 进程里拿不到，
 * 所以这里要自带与 vitest.config.ts 相同的默认值。
 */
export default async function globalSetup(): Promise<void> {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5434/ai_writing_test';

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });
  } finally {
    await pool.end();
  }
}
