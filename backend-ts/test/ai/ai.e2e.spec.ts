import { type INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { buildTestApp, llmCalls, registerUser } from '../utils/app';
import { truncateAll, closeTestDb } from '../utils/db';
import { LlmHttpError } from '../../src/ai/llm/llm-client.interface';
import { SYSTEM_PROMPTS } from '../../src/ai/prompts';

let app: INestApplication;

async function createBook(auth: Record<string, string>, title = '测试书') {
  const res = await request(app.getHttpServer()).post('/api/books').set(auth).send({ title });
  return res.body as { id: string };
}

async function createChapter(
  auth: Record<string, string>,
  bookId: string,
  content: string,
): Promise<string> {
  const created = await request(app.getHttpServer())
    .post(`/api/books/${bookId}/chapters`)
    .set(auth)
    .send({});
  const id = created.body.id as string;
  await request(app.getHttpServer())
    .put('/api/chapters/save')
    .set(auth)
    .send({ chapter_id: id, title: null, content });
  return id;
}

/** SSE 文本 → data 负载字符串列表（含字面量 [DONE]） */
function sseFrames(text: string): string[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));
}

function jsonFrames(text: string) {
  return sseFrames(text)
    .filter((f) => f !== '[DONE]')
    .map((f) => JSON.parse(f) as { type: string; data: Record<string, unknown> });
}

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

beforeEach(async () => {
  await truncateAll();
  llmCalls.length = 0;
});

describe('AI 端点：认证与书籍归属', () => {
  it('无 token → 403 Not authenticated', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/chat')
      .send({ book_id: 'x', message: '你好' });
    expect(res.status).toBe(403);
    expect(res.body.detail).toBe('Not authenticated');
  });

  it('book_id 非 UUID → 404 作品不存在（不给 PG 抛 500 的机会）', async () => {
    const { auth } = await registerUser(app, 'ai-auth-1@test.dev');
    const res = await request(app.getHttpServer())
      .post('/api/ai/chat')
      .set(auth)
      .send({ book_id: 'not-a-uuid', message: '你好' });
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe('作品不存在');
  });

  it('别人的书 → 404 作品不存在', async () => {
    const owner = await registerUser(app, 'ai-owner-1@test.dev');
    const intruder = await registerUser(app, 'ai-intruder-1@test.dev');
    const book = await createBook(owner.auth);
    const res = await request(app.getHttpServer())
      .post('/api/ai/chat')
      .set(intruder.auth)
      .send({ book_id: book.id, message: '你好' });
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe('作品不存在');
  });
});

describe('POST /api/ai/chat（非流式）', () => {
  it('system 用 chat 人格；user 内容含作品记忆与【用户问题】；返回 {data:{answer}}', async () => {
    const { auth } = await registerUser(app, 'ai-chat-1@test.dev');
    const book = await createBook(auth, '星辰变');
    await createChapter(auth, book.id, '张三在青云山练剑十年，剑法大成。');

    const res = await request(app.getHttpServer())
      .post('/api/ai/chat')
      .set(auth)
      .send({ book_id: book.id, message: '帮我设计下一章' });

    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe('这是测试用的 AI 回复。');

    const opts = llmCalls.at(-1)!;
    expect(opts.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPTS.chat });
    const userMsg = opts.messages.at(-1)!.content;
    expect(userMsg).toContain('【作品记忆】');
    expect(userMsg).toContain('作品名：星辰变');
    expect(userMsg).toContain('【用户问题】\n帮我设计下一章');
  });

  it('历史消息透传（最近 10 条）', async () => {
    const { auth } = await registerUser(app, 'ai-chat-2@test.dev');
    const book = await createBook(auth);
    const history = [
      { role: 'user', content: '历史1' },
      { role: 'assistant', content: '回答1' },
    ];
    await request(app.getHttpServer())
      .post('/api/ai/chat')
      .set(auth)
      .send({ book_id: book.id, message: '新问题', history });

    const messages = llmCalls.at(-1)!.messages;
    expect(messages.map((m) => m.content)).toContain('历史1');
    expect(messages.map((m) => m.content)).toContain('回答1');
  });

  it('上游余额不足 → 500 + 充值提示文案', async () => {
    const balanceApp = await buildTestApp({
      chat: async () => {
        throw new LlmHttpError(402, { message: 'Insufficient balance' }, '');
      },
    });
    try {
      const { auth } = await registerUser(balanceApp, 'ai-chat-3@test.dev');
      const book = await createBook(auth);
      const res = await request(balanceApp.getHttpServer())
        .post('/api/ai/chat')
        .set(auth)
        .send({ book_id: book.id, message: '你好' });
      expect(res.status).toBe(500);
      expect(res.body.detail).toBe('SiliconFlow 账户余额不足，请充值后重试');
    } finally {
      await balanceApp.close();
    }
  });
});

describe('POST /api/ai/chat/stream（SSE）', () => {
  it('token… → done → 字面量 [DONE]，响应头齐备', async () => {
    const { auth } = await registerUser(app, 'ai-stream-1@test.dev');
    const book = await createBook(auth);

    const res = await request(app.getHttpServer())
      .post('/api/ai/chat/stream')
      .set(auth)
      .send({ book_id: book.id, message: '你好' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const frames = jsonFrames(res.text);
    expect(frames.slice(0, -1).map((f) => f.type)).toEqual(['token', 'token', 'token']);
    expect(frames[0].data).toEqual({ text: '这是' });
    expect(frames.at(-1)!.type).toBe('done');
    // 最后必须是字面量哨兵，且只出现一次
    const raw = sseFrames(res.text);
    expect(raw.at(-1)).toBe('[DONE]');
    expect(raw.filter((f) => f === '[DONE]')).toHaveLength(1);
  });

  it('流中途出错 → in-band error 帧 + [DONE]，HTTP 仍是 200', async () => {
    const errApp = await buildTestApp({
      chatStream: async function* (): AsyncIterable<string> {
        yield '先吐一个字';
        throw new LlmHttpError(401, { message: 'bad key' }, '');
      },
    });
    try {
      const { auth } = await registerUser(errApp, 'ai-stream-2@test.dev');
      const book = await createBook(auth);
      const res = await request(errApp.getHttpServer())
        .post('/api/ai/chat/stream')
        .set(auth)
        .send({ book_id: book.id, message: '你好' });

      expect(res.status).toBe(200);
      const frames = jsonFrames(res.text);
      expect(frames[0].type).toBe('token');
      const errorFrame = frames.find((f) => f.type === 'error');
      expect((errorFrame!.data as { message: string }).message).toMatch(/^SiliconFlow API Key/);
      expect(sseFrames(res.text).at(-1)).toBe('[DONE]');
    } finally {
      await errApp.close();
    }
  });
});

describe('POST /api/ai/write', () => {
  const cases: Array<[string, string]> = [
    ['improve', '请润色以下文本'],
    ['fix', '请校对以下文本，修正错别字和语病'],
    ['summarize', '请概括以下内容'],
  ];

  it.each(cases)('command=%s 使用对应短模板', async (command, marker) => {
    const { auth } = await registerUser(app, `ai-write-${command}@test.dev`);
    const book = await createBook(auth);
    await request(app.getHttpServer())
      .post('/api/ai/write')
      .set(auth)
      .send({ book_id: book.id, content: '张三拔剑。', command });
    expect(llmCalls.at(-1)!.messages[0].content).toBe(SYSTEM_PROMPTS[command]);
    expect(llmCalls.at(-1)!.messages.at(-1)!.content).toContain(marker);
  });

  it('command=continue 携带作品记忆与【续写任务】', async () => {
    const { auth } = await registerUser(app, 'ai-write-continue@test.dev');
    const book = await createBook(auth, '凡人修仙');
    const chapterId = await createChapter(auth, book.id, '李四踏入山门。');

    await request(app.getHttpServer())
      .post('/api/ai/write')
      .set(auth)
      .send({ book_id: book.id, content: '李四踏入山门，只见', command: 'continue', chapter_id: chapterId });

    expect(llmCalls.at(-1)!.messages[0].content).toBe(SYSTEM_PROMPTS.continue);
    const userMsg = llmCalls.at(-1)!.messages.at(-1)!.content;
    expect(userMsg).toContain('【作品记忆】');
    expect(userMsg).toContain('【当前章节草稿】');
    expect(userMsg).toContain('【续写任务】');
    expect(userMsg).toContain('【当前续写位置】\n李四踏入山门，只见');
  });

  it('未知 command：人格回退 chat，正文裸传', async () => {
    const { auth } = await registerUser(app, 'ai-write-unknown@test.dev');
    const book = await createBook(auth);
    await request(app.getHttpServer())
      .post('/api/ai/write')
      .set(auth)
      .send({ book_id: book.id, content: '一段正文', command: '别的' });
    expect(llmCalls.at(-1)!.messages[0].content).toBe(SYSTEM_PROMPTS.chat);
    expect(llmCalls.at(-1)!.messages.at(-1)!.content).toBe('一段正文');
  });

  it('write/stream 输出 SSE token 流', async () => {
    const { auth } = await registerUser(app, 'ai-write-stream@test.dev');
    const book = await createBook(auth);
    const res = await request(app.getHttpServer())
      .post('/api/ai/write/stream')
      .set(auth)
      .send({ book_id: book.id, content: '正文', command: 'improve' });
    expect(res.status).toBe(200);
    const frames = jsonFrames(res.text);
    expect(frames.at(-1)!.type).toBe('done');
    expect(frames[0].type).toBe('token');
    expect(sseFrames(res.text).at(-1)).toBe('[DONE]');
  });
});

describe('POST /api/ai/polish-diff（非流式）', () => {
  it('空文本 → 400 需要提供待润色文本', async () => {
    const { auth } = await registerUser(app, 'ai-polish-1@test.dev');
    const book = await createBook(auth);
    const res = await request(app.getHttpServer())
      .post('/api/ai/polish-diff')
      .set(auth)
      .send({ book_id: book.id, content: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('需要提供待润色文本');
  });

  it('返回 diff 结果：original/revised/segments/summary，maxTokens 与 temperature 生效', async () => {
    const polishApp = await buildTestApp({
      chat: async () => ({ answer: '张三缓缓拔出长剑。' }),
    });
    try {
      const { auth } = await registerUser(polishApp, 'ai-polish-2@test.dev');
      const book = await createBook(auth);
      const original = '张三很快的拔出了剑。';

      const res = await request(polishApp.getHttpServer())
        .post('/api/ai/polish-diff')
        .set(auth)
        .send({ book_id: book.id, content: original, instruction: '更文学一点' });

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.original).toBe(original);
      expect(data.revised).toBe('张三缓缓拔出长剑。');
      expect(data.instruction).toBe('更文学一点');
      expect(data.truncated).toBe(false);
      expect(data.original_length).toBe(10);
      expect(data.processed_length).toBe(10);
      expect(Array.isArray(data.segments)).toBe(true);
      expect(data.summary.length).toBeGreaterThan(0);

      const opts = llmCalls.at(-1)!;
      expect(opts.temperature).toBe(0.35);
      expect(opts.maxTokens).toBe(512); // floor(10*1.4)+384=398 → 下限 512
      expect(opts.messages[0].content).toBe(SYSTEM_PROMPTS.polish_diff);
      expect(opts.messages.at(-1)!.content).toContain('【AI 修改审阅任务】');
      expect(opts.messages.at(-1)!.content).toContain('【用户修改要求】\n更文学一点');
      expect(opts.messages.at(-1)!.content).toContain(`【待处理文本】\n${original}`);
    } finally {
      await polishApp.close();
    }
  });

  it('超 3000 字截断：truncated=true，revised = 改文 + 原尾部', async () => {
    const polishApp = await buildTestApp({
      chat: async () => ({ answer: '改写过的开头。' }),
    });
    try {
      const { auth } = await registerUser(polishApp, 'ai-polish-3@test.dev');
      const book = await createBook(auth);
      const original = '字'.repeat(3500);

      const res = await request(polishApp.getHttpServer())
        .post('/api/ai/polish-diff')
        .set(auth)
        .send({ book_id: book.id, content: original });

      const data = res.body.data;
      expect(data.original).toBe('字'.repeat(3000));
      expect(data.revised).toBe('改写过的开头。' + '字'.repeat(500));
      expect(data.truncated).toBe(true);
      expect(data.original_length).toBe(3500);
      expect(data.processed_length).toBe(3000);
      expect(llmCalls.at(-1)!.maxTokens).toBe(4096); // floor(3000*1.4)+384 → 上限
    } finally {
      await polishApp.close();
    }
  });
});

describe('POST /api/ai/polish-diff/stream', () => {
  it('meta → token… → result → done → [DONE]', async () => {
    const polishApp = await buildTestApp({
      chatStream: async function* (): AsyncIterable<string> {
        yield '张三缓缓';
        yield '拔出长剑。';
      },
    });
    try {
      const { auth } = await registerUser(polishApp, 'ai-polish-stream@test.dev');
      const book = await createBook(auth);
      const res = await request(polishApp.getHttpServer())
        .post('/api/ai/polish-diff/stream')
        .set(auth)
        .send({ book_id: book.id, content: '张三很快的拔出了剑。' });

      expect(res.status).toBe(200);
      const frames = jsonFrames(res.text);
      expect(frames[0].type).toBe('meta');
      expect(frames[0].data).toMatchObject({
        original: '张三很快的拔出了剑。',
        truncated: false,
        original_length: 10,
        processed_length: 10,
      });
      expect(frames[0].data).toHaveProperty('instruction');

      const types = frames.map((f) => f.type);
      expect(types.indexOf('result')).toBeGreaterThan(types.indexOf('token'));
      expect(types.at(-1)).toBe('done');
      expect(sseFrames(res.text).at(-1)).toBe('[DONE]');

      const result = frames.find((f) => f.type === 'result')!.data as Record<string, unknown>;
      expect(result.revised).toBe('张三缓缓拔出长剑。');
      expect(result).toHaveProperty('segments');
      expect(result).toHaveProperty('summary');
    } finally {
      await polishApp.close();
    }
  });
});

describe('POST /api/ai/extract-characters', () => {
  it('正文太短 → 400', async () => {
    const { auth } = await registerUser(app, 'ai-extract-1@test.dev');
    const book = await createBook(auth);
    const res = await request(app.getHttpServer())
      .post('/api/ai/extract-characters')
      .set(auth)
      .send({ book_id: book.id, content: '太短了' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('正文内容太短，无法识别人物');
  });

  it('解析并归一化人物列表', async () => {
    const extractApp = await buildTestApp({
      chat: async () => ({
        answer:
          '```json\n' +
          JSON.stringify({
            characters: [
              { name: '张三', role: '主角', bio: '青云山弟子', confidence: 0.9 },
              { name: '李四', role: '反派' },
            ],
          }) +
          '\n```',
      }),
    });
    try {
      const { auth } = await registerUser(extractApp, 'ai-extract-2@test.dev');
      const book = await createBook(auth);
      const res = await request(extractApp.getHttpServer())
        .post('/api/ai/extract-characters')
        .set(auth)
        .send({
          book_id: book.id,
          content: '这是一段足够长的正文，'.repeat(3),
          chapter_id: null,
        });

      expect(res.status).toBe(200);
      const characters = res.body.data.characters;
      expect(characters[0]).toEqual({
        name: '张三',
        role: '主角',
        bio: '青云山弟子',
        confidence: 0.9,
      });
      expect(characters[1]).toEqual({ name: '李四', role: '反派', bio: '', confidence: 0.7 });
    } finally {
      await extractApp.close();
    }
  });

  it('AI 输出无法解析 → 502 AI 返回格式无法解析，请重试', async () => {
    const extractApp = await buildTestApp({
      chat: async () => ({ answer: '这不是 JSON' }),
    });
    try {
      const { auth } = await registerUser(extractApp, 'ai-extract-3@test.dev');
      const book = await createBook(auth);
      const res = await request(extractApp.getHttpServer())
        .post('/api/ai/extract-characters')
        .set(auth)
        .send({ book_id: book.id, content: '这是一段足够长的正文。'.repeat(3) });
      expect(res.status).toBe(502);
      expect(res.body.detail).toBe('AI 返回格式无法解析，请重试');
    } finally {
      await extractApp.close();
    }
  });
});

describe('POST /api/ai/outline', () => {
  it('拼装大纲 prompt 并透传 model', async () => {
    const { auth } = await registerUser(app, 'ai-outline-1@test.dev');
    const book = await createBook(auth);
    await request(app.getHttpServer())
      .post('/api/ai/outline')
      .set(auth)
      .send({
        book_id: book.id,
        title: '星辰变',
        genre: '玄幻',
        chapter_count: 6,
        existing_outline: '已有第一卷',
        model: 'glm-4-test',
      });

    const opts = llmCalls.at(-1)!;
    expect(opts.model).toBe('glm-4-test');
    expect(opts.messages[0].content).toBe(SYSTEM_PROMPTS.outline);
    const userMsg = opts.messages.at(-1)!.content;
    expect(userMsg).toContain('小说标题：星辰变');
    expect(userMsg).toContain('题材：玄幻');
    expect(userMsg).toContain('章节数：6');
    expect(userMsg).toContain('现有大纲：已有第一卷');
  });

  it('失败时用朴素文案（不走 extractAiError）', async () => {
    const outlineApp = await buildTestApp({
      chat: async () => {
        throw new Error('网络断了');
      },
    });
    try {
      const { auth } = await registerUser(outlineApp, 'ai-outline-2@test.dev');
      const book = await createBook(auth);
      const res = await request(outlineApp.getHttpServer())
        .post('/api/ai/outline')
        .set(auth)
        .send({ book_id: book.id, title: '书名' });
      expect(res.status).toBe(500);
      expect(res.body.detail).toBe('AI 服务调用失败: 网络断了');
    } finally {
      await outlineApp.close();
    }
  });

  it('chapter_count 缺省为 5', async () => {
    const { auth } = await registerUser(app, 'ai-outline-3@test.dev');
    const book = await createBook(auth);
    await request(app.getHttpServer())
      .post('/api/ai/outline')
      .set(auth)
      .send({ book_id: book.id, title: '书名' });
    expect(llmCalls.at(-1)!.messages.at(-1)!.content).toContain('章节数：5');
  });
});
