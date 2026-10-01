import { type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { buildTestApp, llmCalls, registerUser, type FakeLlmOverrides } from '../utils/app';
import { truncateAll, closeTestDb } from '../utils/db';
import type { LlmResult } from '../../src/ai/llm/llm-client.interface';
import { SYSTEM_PROMPTS } from '../../src/ai/prompts';

let app: INestApplication | undefined;

/** 每个 describe 用「按脚本回的假模型」构建自己的 App 实例，用前关掉上一个 */
async function resetApp(llm: FakeLlmOverrides = {}) {
  if (app) {
    await app.close();
  }
  app = await buildTestApp(llm);
}

async function createBook(auth: Record<string, string>, title = '测试书') {
  const res = await request(app.getHttpServer()).post('/api/books').set(auth).send({ title });
  return res.body as { id: string };
}

async function createChapter(auth: Record<string, string>, bookId: string, content: string) {
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

/** 脚本化多轮假模型：按调用次序返回预排好的 LlmResult */
function scriptedChat(script: LlmResult[]): FakeLlmOverrides['chat'] {
  let round = 0;
  return async () => script[Math.min(round++, script.length - 1)];
}

const SEARCH_CALL: LlmResult = {
  answer: '先看看前文。',
  toolCalls: [{ id: 'call_1', name: 'search_story', argumentsJson: '{"query":"剑法"}' }],
};

/** 最近一次 LLM 调用里回灌的某工具结果消息 */
function toolResultOf(name: string): string {
  const msg = [...llmCalls].reverse().flatMap((c) => c.messages).find(
    (m) => m.role === 'tool' && m.toolName === name,
  );
  return msg?.content ?? '';
}

afterAll(async () => {
  await app?.close();
  await closeTestDb();
});

beforeEach(async () => {
  await truncateAll();
  llmCalls.length = 0;
});

describe('Agent 端点：认证与书籍归属', () => {
  beforeAll(() => resetApp());

  it('无 token → 403；别人的书 → 404', async () => {
    const res1 = await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .send({ book_id: 'x', message: '你好' });
    expect(res1.status).toBe(403);

    const owner = await registerUser(app!, 'agent-owner@test.dev');
    const intruder = await registerUser(app!, 'agent-intruder@test.dev');
    const book = await createBook(owner.auth);
    const res2 = await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(intruder.auth)
      .send({ book_id: book.id, message: '你好' });
    expect(res2.status).toBe(404);
    expect(res2.body.detail).toBe('作品不存在');
  });
});

describe('POST /api/ai/agent（非流式）', () => {
  beforeAll(() =>
    resetApp({
      chat: scriptedChat([SEARCH_CALL, { answer: '张三在青云山练成了剑法。' }]),
    }),
  );

  it('一轮工具调用 → 二轮作答；请求带工具表；工具结果回灌 messages', async () => {
    const { auth } = await registerUser(app!, 'agent-chat-1@test.dev');
    const book = await createBook(auth, '青云志');
    await createChapter(auth, book.id, '张三练剑。');

    const res = await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '张三的剑练得怎么样了？' });

    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe('张三在青云山练成了剑法。');
    expect(res.body.data.rounds).toBe(2);
    expect(res.body.data.trace).toEqual([
      { round: 1, thought: '先看看前文。', tools: [{ name: 'search_story', ok: true }] },
    ]);

    // 第 1 轮：system 是 agent 人格，带工具规格
    expect(llmCalls.length).toBe(2);
    expect(llmCalls[0].messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPTS.agent });
    const toolNames = (llmCalls[0].tools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['search_story', 'get_characters', 'get_outline', 'get_recent_chapters']),
    );

    // 第 2 轮：assistant 带 toolCalls 原样回传 + role:'tool' 结果消息
    const msgs2 = llmCalls[1].messages;
    const assistantMsg = msgs2.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    const toolMsg = msgs2.find((m) => m.role === 'tool');
    expect(assistantMsg?.toolCalls).toEqual(SEARCH_CALL.toolCalls);
    expect(toolMsg?.toolCallId).toBe('call_1');
    expect(toolMsg?.toolName).toBe('search_story');
    expect(toolMsg?.content).toBeTruthy();

    // 初始上下文只有最小信息（书名/简介），不替模型塞整段作品记忆
    const firstUserMsg = llmCalls[0].messages.at(-1)!.content;
    expect(firstUserMsg).toContain('【用户问题】');
    expect(firstUserMsg).not.toContain('【作品记忆】');
    const bookInfo = llmCalls[0].messages.find(
      (m) => m.role === 'system' && m.content.includes('【当前作品】'),
    );
    expect(bookInfo?.content).toContain('青云志');
  });
});

describe('POST /api/ai/agent：容错', () => {
  beforeAll(() =>
    resetApp({
      chat: scriptedChat([
        {
          answer: '',
          toolCalls: [{ id: 'b1', name: '不存在_的工具', argumentsJson: '{坏掉的 json' }],
        },
        { answer: '工具虽坏，回答照来。' },
      ]),
    }),
  );

  it('未知工具 + 坏 JSON 参数 → ok:false 回灌，循环不炸，照常作答', async () => {
    const { auth } = await registerUser(app!, 'agent-bad@test.dev');
    const book = await createBook(auth);

    const res = await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '随便聊聊' });

    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe('工具虽坏，回答照来。');
    expect(res.body.data.trace[0].tools).toEqual([{ name: '不存在_的工具', ok: false }]);
    const toolMsg = llmCalls.at(-1)!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('未知工具');
  });
});

describe('POST /api/ai/agent：轮数上限', () => {
  beforeAll(() =>
    resetApp({
      chat: async (options) =>
        options.tools
          ? { answer: '', toolCalls: [{ id: 'loop', name: 'get_outline', argumentsJson: '{}' }] }
          : { answer: '（基于已收集信息的最终回答）' },
    }),
  );

  it('模型死循环调工具 → 4 轮后摘掉工具表收官', async () => {
    const { auth } = await registerUser(app!, 'agent-loop@test.dev');
    const book = await createBook(auth);

    const res = await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '大纲是什么？' });

    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe('（基于已收集信息的最终回答）');
    expect(res.body.data.rounds).toBe(5);
    // 带工具的轮次 = 上限 4，最后一轮不带工具
    const withTools = llmCalls.filter((c) => c.tools?.length);
    expect(withTools.length).toBe(4);
    expect(llmCalls.at(-1)!.tools).toBeUndefined();
    expect(llmCalls.at(-1)!.messages.at(-1)!.content).toContain('工具调用已达上限');
  });
});

describe('POST /api/ai/agent/stream（SSE）', () => {
  beforeAll(() =>
    resetApp({
      chat: scriptedChat([
        {
          answer: '查一下人物。',
          toolCalls: [{ id: 'c1', name: 'get_characters', argumentsJson: '{"names":["李四"]}' }],
        },
        { answer: '李四是主角，正在流浪。' },
      ]),
    }),
  );

  it('SSE 事件序列：step → tool_call → tool_result → token… → done → [DONE]', async () => {
    const { auth } = await registerUser(app!, 'agent-sse@test.dev');
    const book = await createBook(auth);
    await request(app!.getHttpServer())
      .post(`/api/books/${book.id}/characters`)
      .set(auth)
      .send({ name: '李四', role: '主角', bio: '流浪剑客' });

    const res = await request(app!.getHttpServer())
      .post('/api/ai/agent/stream')
      .set(auth)
      .send({ book_id: book.id, message: '介绍一下李四' });

    expect(res.status).toBe(200);
    expect(res.headers['x-accel-buffering']).toBe('no');

    const frames = jsonFrames(res.text);
    const types = frames.map((f) => f.type);
    expect(types[0]).toBe('step');
    expect(types[1]).toBe('tool_call');
    expect(types[2]).toBe('tool_result');
    expect(types.slice(3, -1).every((t) => t === 'token')).toBe(true);
    expect(types.at(-1)).toBe('done');
    expect(sseFrames(res.text).at(-1)).toBe('[DONE]');

    // 步骤内容
    expect(frames[0].data).toEqual({ round: 1, thought: '查一下人物。' });
    expect(frames[1].data).toMatchObject({ name: 'get_characters', args: { names: ['李四'] } });
    expect(frames[2].data).toMatchObject({ name: 'get_characters', ok: true });
    expect(String(frames[2].data.content)).toContain('李四');

    // token 帧拼起来就是最终回答
    const answer = frames
      .filter((f) => f.type === 'token')
      .map((f) => f.data.text)
      .join('');
    expect(answer).toBe('李四是主角，正在流浪。');
  });
});

describe('Agent 工具箱：get_chapter / save_inspiration / diff_edit', () => {
  it('get_chapter 读整章正文；order 指定章节', async () => {
    await resetApp({
      chat: scriptedChat([
        { answer: '', toolCalls: [{ id: 'g1', name: 'get_chapter', argumentsJson: '{"order":1}' }] },
        { answer: '读完第一章了。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools-1@test.dev');
    const book = await createBook(auth);
    await createChapter(auth, book.id, '第一章正文：少年走出山门。');

    const res = await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '第一章讲了什么？' });

    expect(res.status).toBe(200);
    expect(toolResultOf('get_chapter')).toContain('第一章正文：少年走出山门。');
  });

  it('save_inspiration 真正把灵感写进数据库（tag 契约与设定库一致）', async () => {
    await resetApp({
      chat: scriptedChat([
        {
          answer: '',
          toolCalls: [
            {
              id: 's1',
              name: 'save_inspiration',
              argumentsJson: '{"title":"剑灵设定","content":"剑里住着千年剑灵","tags":["设定","伏笔"]}',
            },
          ],
        },
        { answer: '已记下这个灵感。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools-2@test.dev');
    const book = await createBook(auth);

    await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '这个设定不错，记下来' });

    // 经公开 API 验证落库（tags 是 JSON 字符串契约）
    const list = await request(app!.getHttpServer()).get('/api/inspirations').set(auth);
    expect(list.status).toBe(200);
    const rows = (list.body as Array<{ title: string; content: string; tags: string }>).filter(
      (i) => i.title === '剑灵设定',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('剑里住着千年剑灵');
    expect(JSON.parse(rows[0].tags)).toEqual(['设定', '伏笔']);
    expect(toolResultOf('save_inspiration')).toContain('已存入灵感库');
  });

  it('diff_edit 产出逐字差异报告，且不动数据库里的章节', async () => {
    await resetApp({
      chat: scriptedChat([
        {
          answer: '',
          toolCalls: [
            {
              id: 'd1',
              name: 'diff_edit',
              argumentsJson: JSON.stringify({ original: '天非常黑', revised: '天黑得像墨' }),
            },
          ],
        },
        { answer: '改动在上面，看看是否采纳。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools-3@test.dev');
    const book = await createBook(auth);
    const chapterId = await createChapter(auth, book.id, '天非常黑。');

    await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '帮我把「天非常黑」改得生动点' });

    const report = toolResultOf('diff_edit');
    expect(report).toContain('将「非常黑」改为「黑得像墨」');
    expect(report).toContain('共 1 处修改');

    // 章节正文必须原封不动（agent 只有提案权，没有改稿权）
    const ch = await request(app!.getHttpServer()).get(`/api/chapters/${chapterId}`).set(auth);
    expect(ch.body.content).toBe('天非常黑。');
  });

  it('diff_edit 的 original 与 revised 相同 → 明确报告「没有改动」', async () => {
    await resetApp({
      chat: scriptedChat([
        {
          answer: '',
          toolCalls: [
            { id: 'd2', name: 'diff_edit', argumentsJson: '{"original":"同上","revised":"同上"}' },
          ],
        },
        { answer: '无改动。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools-4@test.dev');
    const book = await createBook(auth);

    await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '测试' });

    expect(toolResultOf('diff_edit')).toContain('没有任何改动');
  });
});

describe('Agent 工具箱（二）：list_chapters / get_character_relations / list_inspirations / save_character', () => {
  it('list_chapters 给出全书结构目录（不含正文）', async () => {
    await resetApp({
      chat: scriptedChat([
        { answer: '', toolCalls: [{ id: 'l1', name: 'list_chapters', argumentsJson: '{}' }] },
        { answer: '全书共两章。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools2-1@test.dev');
    const book = await createBook(auth);
    await createChapter(auth, book.id, '第一段剧情。');
    await createChapter(auth, book.id, '第二段剧情。');

    await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '现在写到哪了？' });

    const result = toolResultOf('list_chapters');
    expect(result).toContain('第1章');
    expect(result).toContain('第2章');
    expect(result).not.toContain('第一段剧情'); // 目录不含正文
  });

  it('get_character_relations 把 id 解析成人物名', async () => {
    await resetApp({
      chat: scriptedChat([
        { answer: '', toolCalls: [{ id: 'r1', name: 'get_character_relations', argumentsJson: '{}' }] },
        { answer: '张三是李四的师父。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools2-2@test.dev');
    const book = await createBook(auth);
    const a = await request(app!.getHttpServer())
      .post(`/api/books/${book.id}/characters`)
      .set(auth)
      .send({ name: '张三', role: '师父', bio: '剑客' });
    const b = await request(app!.getHttpServer())
      .post(`/api/books/${book.id}/characters`)
      .set(auth)
      .send({ name: '李四', role: '主角', bio: '徒弟' });
    await request(app!.getHttpServer())
      .post(`/api/books/${book.id}/character-relations`)
      .set(auth)
      .send({
        source_character_id: a.body.id,
        target_character_id: b.body.id,
        relation_type: 'mentor',
        description: '亦师亦父',
        strength: 4,
      });

    await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '张三和李四是什么关系？' });

    const result = toolResultOf('get_character_relations');
    expect(result).toContain('张三 —mentor');
    expect(result).toContain('李四');
    expect(result).toContain('亦师亦父');
  });

  it('save_character 入库 + 同名查重不重复创建', async () => {
    await resetApp({
      // 第一轮建人物；第三轮再「建」同名人物验证查重
      chat: scriptedChat([
        {
          answer: '',
          toolCalls: [
            { id: 'c1', name: 'save_character', argumentsJson: '{"name":"王五","role":"反派","bio":"黑市头目"}' },
          ],
        },
        {
          answer: '',
          toolCalls: [
            { id: 'c2', name: 'save_character', argumentsJson: '{"name":"王五","role":"主角"}' },
          ],
        },
        { answer: '王五已经在库里了。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools2-3@test.dev');
    const book = await createBook(auth);

    await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '把反派王五存进人物库' });

    // 公开 API 回读：只有一行，且保留第一次的角色/简介
    const list = await request(app!.getHttpServer())
      .get(`/api/books/${book.id}/characters`)
      .set(auth);
    const rows = (list.body as Array<{ name: string; role: string; bio: string }>).filter(
      (c) => c.name === '王五',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe('反派');
    expect(rows[0].bio).toBe('黑市头目');

    const msgs = llmCalls.map((c) => c.messages).flat();
    const dupMsg = msgs.find((m) => m.role === 'tool' && m.content.includes('已在设定库中'));
    expect(dupMsg).toBeTruthy();
  });

  it('list_inspirations 能回读之前存下的点子（含 tags）', async () => {
    await resetApp({
      chat: scriptedChat([
        { answer: '', toolCalls: [{ id: 'i1', name: 'list_inspirations', argumentsJson: '{}' }] },
        { answer: '灵感库里有一条关于剑灵的设定。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools2-4@test.dev');
    const book = await createBook(auth);
    await request(app!.getHttpServer())
      .post(`/api/books/${book.id}/inspirations`)
      .set(auth)
      .send({ title: '剑灵设定', content: '剑里住着千年剑灵', tags: ['设定'] });

    await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '我之前存过什么点子？' });

    const result = toolResultOf('list_inspirations');
    expect(result).toContain('剑灵设定');
    expect(result).toContain('[设定]');
  });
});
