import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/core/http-exception.filter';
import {
  LLM_CLIENT,
  type LlmCallOptions,
  type LlmClient,
  type LlmResult,
} from '../../src/ai/llm/llm-client.interface';

/**
 * 构建与 main.ts 同构的测试应用（前缀/过滤器一致，但不跑迁移、不监听端口）。
 * 配置由 AppModule 自己的 ConfigModule.forRoot 提供；
 * 环境变量来自 vitest env 注入（进程 env 优先于 .env 文件）。
 * 对应 Python conftest 的 async_client fixture。
 *
 * LLM_CLIENT 默认替换成假实现（章节保存会触发 RAG 向量化，绝不能碰真网络）；
 * 需要观察 prompt / 控制输出 / 构造向量的测试传 llm 覆盖项。
 */
export interface FakeLlmOverrides {
  chat?: (options: LlmCallOptions) => Promise<LlmResult>;
  chatStream?: (options: LlmCallOptions) => AsyncIterable<string>;
  embed?: (texts: string[]) => Promise<number[][]>;
}

/**
 * 所有测试 App 实例的 LLM 调用记录（默认 fake 与自定义 fake 都会往里 push）。
 * beforeEach 里清空（llmCalls.length = 0）。
 */
export const llmCalls: LlmCallOptions[] = [];

export async function buildTestApp(llm: FakeLlmOverrides = {}): Promise<INestApplication> {
  const record = (options: LlmCallOptions) => {
    llmCalls.push(options);
  };
  const fake: LlmClient = {
    chat:
      llm.chat ??
      (async (options: LlmCallOptions) => ({
        answer: '这是测试用的 AI 回复。',
      })),
    chatStream:
      llm.chatStream ??
      (async function* (): AsyncIterable<string> {
        yield '这是';
        yield '测试用的';
        yield ' AI 回复。';
      }),
    embed: llm.embed ?? (async (texts: string[]) => texts.map((t) => fakeEmbedding(t))),
  };
  // 统一包装：无论默认还是自定义实现，调用参数都进入 llmCalls
  const recording: LlmClient = {
    chat: async (options) => {
      record(options);
      return fake.chat(options);
    },
    chatStream: (options) => {
      record(options);
      return fake.chatStream(options);
    },
    embed: (texts) => fake.embed(texts),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(LLM_CLIENT)
    .useValue(recording)
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['/', 'health', 'api/health'] });
  app.useBodyParser('json', { limit: '20mb' });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

/**
 * 确定性假向量：由文本哈希种出的 1024 维单位向量。
 * 相同文本 → 相同向量；不同文本 → 近似正交（供 pgvector 对照测试当对照组用）。
 */
export function fakeEmbedding(text: string, dim = 1024): number[] {
  let seed = 2166136261;
  for (const ch of text) {
    seed ^= ch.codePointAt(0)!;
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const rand = () => {
    // xorshift32
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0xffffffff;
  };
  const vec = Array.from({ length: dim }, () => rand() * 2 - 1);
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  return vec.map((v) => v / norm);
}

/** 注册一个新用户并返回 token + Authorization 头（每个测试用独立邮箱） */
export async function registerUser(app: INestApplication, email: string) {
  const res = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send({ email, password: 'test-pass-1', name: '测试作者' });
  if (res.status !== 200) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const token: string = res.body.access_token;
  return { token, user: res.body.user, auth: { Authorization: `Bearer ${token}` } };
}
