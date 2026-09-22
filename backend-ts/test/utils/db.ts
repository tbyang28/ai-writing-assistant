import { Pool } from 'pg';

/**
 * 测试库直连工具 —— 绕过 Nest DI，用于 TRUNCATE 隔离和"守卫视角外"的
 * 数据操作（如直接删用户行来触发 User not found 分支）。
 * 对应 Python 测试里直接用 async session 操作测试库的做法。
 */

let pool: Pool | null = null;

function getPool(): Pool {
  pool ??= new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5434/ai_writing_test',
    max: 2,
  });
  return pool;
}

/** 每个测试前清空全部业务表（drizzle 迁移表不在列表内，迁移不会重复执行） */
export async function truncateAll(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      'TRUNCATE TABLE users, books, chapters, outlines, characters, ' +
        'character_relations, inspirations, document_chunks ' +
        'RESTART IDENTITY CASCADE',
    );
  } finally {
    client.release();
  }
}

/** 原生 SQL 查询（测试断言库内真实状态时用） */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(sql, params as unknown[]);
  return result.rows as T[];
}

export async function closeTestDb(): Promise<void> {
  await pool?.end();
  pool = null;
}
