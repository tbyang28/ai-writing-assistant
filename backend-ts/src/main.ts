import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './core/http-exception.filter';
import { runMigrations } from './db/migrate';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 全局前缀 api；/、/health、/api/health 三个健康路径排除在外（见 RootController 注释）
  app.setGlobalPrefix('api', { exclude: ['/', 'health', 'api/health'] });

  // 对应 main.py 的 CORSMiddleware(allow_origins=["*"], allow_credentials=False)
  app.enableCors({ origin: '*', credentials: false, methods: '*', allowedHeaders: '*' });

  // 章节正文可能很大：对齐 nginx client_max_body_size 20m
  // （Express 默认 100kb，比 FastAPI 无限制更严，必须显式放宽）
  app.useBodyParser('json', { limit: '20mb' });
  app.useBodyParser('urlencoded', { limit: '20mb', extended: true });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  // 对应 lifespan 里的 init_db()
  await runMigrations(app);

  const port = Number(process.env.PORT ?? 8001);
  await app.listen(port, '0.0.0.0');
  console.log(`backend-ts listening on :${port}`);
}

void bootstrap();
