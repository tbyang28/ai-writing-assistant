import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { DRIZZLE } from './drizzle.module';

/**
 * 启动时执行迁移 —— 对应 Python 侧 lifespan 里的 init_db()（create_all）。
 * 区别：这里是真正的增量迁移（drizzle-kit 生成的 SQL），而非每次启动全量比对。
 */
export async function runMigrations(app: INestApplication): Promise<void> {
  const config = app.get(ConfigService);
  if (!config.get<boolean>('RUN_MIGRATIONS')) {
    return;
  }

  const db = app.get(DRIZZLE, { strict: false });
  if (!db) {
    return;
  }

  const migrationsFolder = join(process.cwd(), 'drizzle');
  // 没有迁移清单时跳过（Phase 1 阶段目录里只有 README 占位）
  const journal = join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journal)) {
    return;
  }

  await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
}
