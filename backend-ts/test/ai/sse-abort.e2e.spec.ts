import { type INestApplication } from '@nestjs/common';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type LlmCallOptions } from '../../src/ai/llm/llm-client.interface';
import { buildTestApp, registerUser } from '../utils/app';
import { closeTestDb, truncateAll } from '../utils/db';

/**
 * SSE 客户端断开取消链路（优化项的回归测试）：
 *
 *   res.on('close') → AbortController.abort() → pipeTokens 看到 signal.aborted
 *   → 停止消费上游生成器（for-await 提前退出触发 generator.return()）
 *
 * supertest 会缓冲整个响应，模拟不了「中途断开」，所以这里把测试 App
 * 真正 listen 到临时端口，用原生 http 客户端读完第一帧就 destroy socket。
 */

let app: INestApplication;
let httpServer: http.Server;
let port: number;

const ENDLESS_MARKER = '[无限流]';
const events: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 内容带 ENDLESS_MARKER 时无限产 token（靠 abort 才会停），否则产 3 块自然结束。
 * finally 里记录结束方式：被取消 / 自然跑完。
 */
async function* fakeStream(options: LlmCallOptions): AsyncIterable<string> {
  const endless = options.messages.some((m) => m.content.includes(ENDLESS_MARKER));
  let i = 0;
  try {
    while (endless || i < 3) {
      await sleep(5);
      // 真实 undici 客户端在 abort 后会抛 AbortError；这里安静退出即可
      if (options.signal?.aborted) {
        return;
      }
      i += 1;
      events.push(`yield-${i}`);
      yield `块${i}`;
    }
  } finally {
    events.push(options.signal?.aborted ? 'stopped-by-abort' : 'completed');
  }
}

beforeAll(async () => {
  app = await buildTestApp({ chatStream: fakeStream });
  httpServer = app.getHttpServer();
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await app.close();
  await closeTestDb();
});

beforeEach(async () => {
  await truncateAll();
  events.length = 0;
});

describe('SSE 客户端断开 → 取消上游 LLM 调用', () => {
  it('断开后生成器提前停止消费（不再白烧 token）', async () => {
    const { auth } = await registerUser(app, `sse-abort-${Date.now()}@test.dev`);
    const bookId = await createBook(auth);

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/ai/write/stream',
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          res.once('data', () => {
            // 收到第一帧就断开 —— 模拟用户关页面/点取消
            res.destroy();
            req.destroy();
            resolve();
          });
          res.on('error', () => undefined); // ECONNRESET 是预期
        },
      );
      req.on('error', () => undefined);
      req.end(
        JSON.stringify({
          book_id: bookId,
          command: 'continue',
          content: `测试正文 ${ENDLESS_MARKER}`,
        }),
      );
    });

    // 等取消传播：close → abort → 生成器 finally
    const deadline = Date.now() + 3000;
    while (!events.some((e) => e === 'stopped-by-abort' || e === 'completed')) {
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for abort; events=${JSON.stringify(events)}`);
      }
      await sleep(10);
    }

    const yieldCount = events.filter((e) => e.startsWith('yield-')).length;
    expect(events).toContain('stopped-by-abort'); // 是被取消掐断的
    expect(yieldCount).toBeGreaterThan(0); // 确实流出过 token（非空转）
    expect(yieldCount).toBeLessThan(50); // 掐得快：个位数量级，远小于无限流
  });

  it('对照组：客户端完整消费时生成器自然跑完（证明上一条不是碰巧）', async () => {
    const { auth } = await registerUser(app, `sse-ok-${Date.now()}@test.dev`);
    const bookId = await createBook(auth);

    const res = await fetch(`http://127.0.0.1:${port}/api/ai/write/stream`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ book_id: bookId, command: 'continue', content: '普通正文' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(events).toContain('completed'); // 生成器自然结束，不是被取消
    expect(events).not.toContain('stopped-by-abort');
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('"type":"done"');
  });
});

async function createBook(auth: Record<string, string>): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/books`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '断开测试书' }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}
