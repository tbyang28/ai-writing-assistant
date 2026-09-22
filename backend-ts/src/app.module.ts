import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnv } from './config/env';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { BooksModule } from './books/books.module';
import { DrizzleModule } from './db/drizzle.module';
import { RootController } from './health/root.controller';

@Module({
  imports: [
    // 配置注册放在 AppModule 本体：走 main.ts 启动和走测试构建器都必然生效
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv as never,
    }),
    DrizzleModule,
    AuthModule,
    BooksModule,
    AiModule,
  ],
  controllers: [RootController],
})
export class AppModule {}
