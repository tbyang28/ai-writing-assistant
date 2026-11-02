import { type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { buildTestApp, llmCalls, registerUser, type FakeLlmOverrides } from '../utils/app';
import { truncateAll, closeTestDb } from '../utils/db';
import type { LlmResult } from '../../src/ai/llm/llm-client.interface';
import type { ProposalView } from '../../src/ai/agent/agent-proposals.service';
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

/** 生命周期/工具/token 事件共用 runId，seq 单调递增；done 保留既有终止协议。 */
function expectRunEvents(frames: ReturnType<typeof jsonFrames>) {
  const events = frames.filter((frame) => frame.type !== 'done');
  expect(events[0].type).toBe('run_start');
  expect(events.at(-1)!.type).toBe('run_end');
  const runId = events[0].data.runId;
  expect(runId).toMatch(/^[a-f0-9-]{36}$/);
  const sequences = events.map((event) => {
    expect(event.data.runId).toBe(runId);
    expect(event.data.seq).toEqual(expect.any(Number));
    return event.data.seq as number;
  });
  expect(sequences[0]).toBe(1);
  expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(true);
  expect(events.at(-1)!.data).toMatchObject({ status: 'completed', metrics: { requestCount: expect.any(Number) } });
}

function expectProposal(proposal: ProposalView, bookId: string, tool: ProposalView['tool']) {
  expect(Object.keys(proposal).sort()).toEqual(['id', 'bookId', 'tool', 'args', 'digest', 'expiresAt', 'status'].sort());
  expect(proposal).toMatchObject({
    id: expect.stringMatching(/^[a-f0-9-]{36}$/), bookId, tool,
    digest: expect.stringMatching(/^[a-f0-9]{64}$/), status: 'pending',
  });
  expect(Date.parse(proposal.expiresAt)).toBeGreaterThan(Date.now());
}

async function confirmProposal(auth: Record<string, string>, proposal: ProposalView) {
  return request(app!.getHttpServer()).post(`/api/ai/proposals/${proposal.id}/confirm`)
    .set(auth).send({ digest: proposal.digest });
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
      chatStream: async function* () {
        yield '李四是主角，';
        yield '正在流浪。';
      },
    }),
  );

  it('SSE 事件序列：run_start → step → tool_call → tool_result → token… → run_end → done → [DONE]', async () => {
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
    expect(types.slice(0, 4)).toEqual(['run_start', 'step', 'tool_call', 'tool_result']);
    expect(types.slice(4, -2)).toEqual(['token', 'token']);
    expect(types.slice(-2)).toEqual(['run_end', 'done']);
    expect(sseFrames(res.text).at(-1)).toBe('[DONE]');
    expectRunEvents(frames);

    // 步骤内容保留既有字段，同时验证工具调用关联和执行状态。
    expect(frames[1].data).toMatchObject({ round: 1, thought: '查一下人物。' });
    expect(frames[2].data).toMatchObject({ name: 'get_characters', args: { names: ['李四'] }, callId: 'c1' });
    expect(frames[3].data).toMatchObject({ name: 'get_characters', ok: true, callId: 'c1', status: 'completed' });
    expect(String(frames[3].data.content)).toContain('李四');

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

  it('save_inspiration 只生成提案；用户确认后保存且重复确认返回同一灵感', async () => {
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
        { answer: '已生成灵感提案，请检查并确认。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools-2@test.dev');
    const book = await createBook(auth);

    const generated = await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '这个设定不错，记下来' });
    expect(generated.status).toBe(200);
    expect(generated.body.data.proposals).toHaveLength(1);
    const proposal = generated.body.data.proposals[0] as ProposalView;
    expectProposal(proposal, book.id, 'save_inspiration');
    expect(proposal.args).toEqual({ title: '剑灵设定', content: '剑里住着千年剑灵', tags: ['设定', '伏笔'] });
    expect(toolResultOf('save_inspiration')).toContain('尚未保存');
    const before = await request(app!.getHttpServer()).get('/api/inspirations').set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toEqual([]);

    const confirmed = await confirmProposal(auth, proposal);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ id: proposal.id, status: 'confirmed', result: {
      id: expect.any(String), tool: 'save_inspiration', created: true,
      inspiration: { title: '剑灵设定', content: '剑里住着千年剑灵', book_id: book.id },
    } });
    const repeated = await confirmProposal(auth, proposal);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual(confirmed.body);

    // 经公开 API 验证只落一行，真实对象 id 与确认结果一致；tags 仍为 JSON 字符串。
    const list = await request(app!.getHttpServer()).get('/api/inspirations').set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(confirmed.body.result.id);
    expect(list.body[0].content).toBe('剑里住着千年剑灵');
    expect(JSON.parse(list.body[0].tags)).toEqual(['设定', '伏笔']);
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

  it('save_character 多个同名提案确认时复用人物，重复确认幂等且保留首次设定', async () => {
    await resetApp({
      // 连续两轮分别提议保存同名人物，Agent 本身不能创建人物。
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
        { answer: '已生成两个人物提案，请检查并确认。' },
      ]),
    });
    const { auth } = await registerUser(app!, 'agent-tools2-3@test.dev');
    const book = await createBook(auth);

    const generated = await request(app!.getHttpServer())
      .post('/api/ai/agent')
      .set(auth)
      .send({ book_id: book.id, message: '把反派王五存进人物库' });
    expect(generated.status).toBe(200);
    const proposals = generated.body.data.proposals as ProposalView[];
    expect(proposals).toHaveLength(2);
    expect(proposals[0].id).not.toBe(proposals[1].id);
    proposals.forEach((proposal) => expectProposal(proposal, book.id, 'save_character'));
    const before = await request(app!.getHttpServer()).get(`/api/books/${book.id}/characters`).set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toEqual([]);
    expect(toolResultOf('save_character')).toContain('尚未保存');

    const first = await confirmProposal(auth, proposals[0]);
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ tool: 'save_character', created: true, character: { role: '反派', bio: '黑市头目' } });
    // 第二提案与第一次重试并发执行，两者都必须复用同一个真实人物 id。
    const [second, repeated] = await Promise.all([
      confirmProposal(auth, proposals[1]), confirmProposal(auth, proposals[0]),
    ]);
    expect(second.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(second.body.result).toMatchObject({ id: first.body.result.id, created: false, character: { role: '反派', bio: '黑市头目' } });
    expect(repeated.body).toEqual(first.body);

    const list = await request(app!.getHttpServer()).get(`/api/books/${book.id}/characters`).set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: first.body.result.id, name: '王五', role: '反派', bio: '黑市头目' });
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

const PROPOSAL_CASES: Array<{
  tool: ProposalView['tool']; args: Record<string, unknown>; listPath: (bookId: string) => string;
}> = [
  { tool: 'save_character', args: { name: '沈川', role: '同伴', bio: '山中医者' }, listPath: (id) => `/api/books/${id}/characters` },
  { tool: 'save_inspiration', args: { title: '古城', content: '古城会随月相移动', tags: ['设定'] }, listPath: () => '/api/inspirations' },
];

describe('Agent 提案完整链路：模型不能确认，用户确认才保存', () => {
  it.each(PROPOSAL_CASES)('$tool 的 confirmed:true 无法绕过确认或授权额外写入', async ({ tool, args, listPath }) => {
    await resetApp({ chat: scriptedChat([
      { answer: '', toolCalls: [{ id: 'forged-confirmation', name: tool, argumentsJson: JSON.stringify({ ...args, confirmed: true }) }] },
      { answer: '', toolCalls: [{ id: 'valid-proposal', name: tool, argumentsJson: JSON.stringify(args) }] },
      { answer: '提案已准备好，等待用户确认。' },
    ]) });
    const { auth } = await registerUser(app!, `agent-forged-${tool}@test.dev`);
    const intruder = await registerUser(app!, `agent-forged-intruder-${tool}@test.dev`);
    const book = await createBook(auth);
    const generated = await request(app!.getHttpServer()).post('/api/ai/agent').set(auth)
      .send({ book_id: book.id, message: '请生成保存提案' });
    expect(generated.status).toBe(200);
    expect(generated.body.data.trace.map((entry: { tools: unknown[] }) => entry.tools)).toEqual([
      [{ name: tool, ok: false }], [{ name: tool, ok: true }],
    ]);
    expect(generated.body.data.proposals).toHaveLength(1);
    const proposal = generated.body.data.proposals[0] as ProposalView;
    expectProposal(proposal, book.id, tool);
    expect(proposal.args).toEqual(args);
    const feedback = llmCalls.flatMap((call) => call.messages)
      .find((message) => message.role === 'tool' && message.toolCallId === 'forged-confirmation');
    expect(feedback?.content).toContain('工具参数无效');

    const before = await request(app!.getHttpServer()).get(listPath(book.id)).set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toEqual([]);
    const forged = await request(app!.getHttpServer()).post(`/api/ai/proposals/${proposal.id}/confirm`)
      .set(auth).send({ digest: proposal.digest, confirmed: true });
    expect(forged.status).toBe(400);
    expect((await confirmProposal(intruder.auth, proposal)).status).toBe(404);
    const stillEmpty = await request(app!.getHttpServer()).get(listPath(book.id)).set(auth);
    expect(stillEmpty.body).toEqual([]);

    const confirmed = await confirmProposal(auth, proposal);
    expect(confirmed.status).toBe(200);
    const repeated = await confirmProposal(auth, proposal);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual(confirmed.body);
    const saved = await request(app!.getHttpServer()).get(listPath(book.id)).set(auth);
    expect(saved.body).toHaveLength(1);
    expect(saved.body[0].id).toBe(confirmed.body.result.id);
  });

  it.each(PROPOSAL_CASES)('$tool SSE 发送结构化 proposal，关联 callId/runId/seq，确认前不保存', async ({ tool, args, listPath }) => {
    await resetApp({
      chat: scriptedChat([
        { answer: '准备保存提案。', toolCalls: [{ id: 'proposal-call', name: tool, argumentsJson: JSON.stringify(args) }] },
        { answer: '请确认提案。' },
      ]),
      chatStream: async function* () { yield '提案待确认，'; yield '请检查。'; },
    });
    const { auth } = await registerUser(app!, `agent-proposal-sse-${tool}@test.dev`);
    const book = await createBook(auth);
    const response = await request(app!.getHttpServer()).post('/api/ai/agent/stream').set(auth)
      .send({ book_id: book.id, message: '把这个设定记下来' });
    expect(response.status).toBe(200);
    expect(response.headers['x-accel-buffering']).toBe('no');
    const frames = jsonFrames(response.text);
    expect(frames.map((frame) => frame.type)).toEqual([
      'run_start', 'step', 'tool_call', 'proposal', 'tool_result', 'token', 'token', 'run_end', 'done',
    ]);
    expectRunEvents(frames);
    expect(sseFrames(response.text).at(-1)).toBe('[DONE]');
    const event = frames[3];
    expect(Object.keys(event.data).sort()).toEqual(['proposal', 'callId', 'runId', 'seq'].sort());
    expect(event.data.callId).toBe('proposal-call');
    expect(event.data.runId).toBe(frames[2].data.runId);
    expect(event.data.seq).toBe((frames[2].data.seq as number) + 1);
    const proposal = event.data.proposal as ProposalView;
    expectProposal(proposal, book.id, tool);
    expect(proposal.args).toEqual(args);
    expect(frames[4].data).toMatchObject({ name: tool, callId: 'proposal-call', ok: true, status: 'completed' });
    expect(String(frames[4].data.content)).toContain('尚未保存');
    expect(frames.filter((frame) => frame.type === 'token').map((frame) => frame.data.text).join('')).toBe('提案待确认，请检查。');
    const before = await request(app!.getHttpServer()).get(listPath(book.id)).set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toEqual([]);
    const confirmed = await confirmProposal(auth, proposal);
    expect(confirmed.status).toBe(200);
    expect((await confirmProposal(auth, proposal)).body).toEqual(confirmed.body);
    const saved = await request(app!.getHttpServer()).get(listPath(book.id)).set(auth);
    expect(saved.body).toHaveLength(1);
    expect(saved.body[0].id).toBe(confirmed.body.result.id);
  });
});
