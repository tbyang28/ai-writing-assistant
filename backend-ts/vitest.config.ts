import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // esbuild 不支持 emitDecoratorMetadata，NestJS 的构造器注入依赖参数类型反射，
  // 必须用 swc 转译测试代码（NestJS 官方文档对 vitest 的推荐做法）
  plugins: [swc.vite()],
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    // 单 worker 顺序跑：所有套件共享同一个测试库（TRUNCATE 隔离），
    // 并行会互相清掉对方的数据
    fileParallelism: false,
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5434/ai_writing_test',
      TEST_DATABASE_URL: 'postgres://postgres:postgres@localhost:5434/ai_writing_test',
      RUN_MIGRATIONS: 'false',
      SECRET_KEY: 'test-secret-key',
    },
  },
});
