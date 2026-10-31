import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeService, type AgentEvent } from '../../src/ai/agent/agent-runtime.service';
import { StoryToolsService } from '../../src/ai/agent/story-tools';
import type { LlmCallOptions, LlmClient, LlmResult } from '../../src/ai/llm/llm-client.interface';
import type { Book } from '../../src/db/schema';

const book = { id: 'book-a', title: '青云志' } as Book;
const messages = [{ role: 'system', content: '只输出正文' }, { role: 'user', content: '续写练剑的故事' }];
const specs = [
  { name: 'get_outline', description: '读大纲', parameters: { type: 'object', properties: {} } },
  { name: 'search_story', description: '检索', parameters: {
    type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
  } },
  { name: 'save_character', description: '存人物', parameters: {
    type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
  } },
];

function setup(script: LlmResult[]) {
  const calls: LlmCallOptions[] = [];
  let index = 0;
  const chat = vi.fn(async (options: LlmCallOptions) => {
    calls.push(options);
    return script[Math.min(index++, script.length - 1)];
  });
  const llm: LlmClient = {
    chat,
    chatStream: vi.fn(async function* (options: LlmCallOptions) {
      calls.push(options);
      yield '少年';
      yield '拔剑。';
    }),
    embed: vi.fn(),
  };
  const execute = vi.fn(async () => ({ ok: true, content: '主角正在练剑' }));
  const tools = { specs, execute } as unknown as StoryToolsService;
  return { runtime: new AgentRuntimeService(llm, tools), calls, execute, llm };
}

function tool(name: string, args = '{}', id = name) {
  return { id, name, argumentsJson: args };
}

describe('自研 Agent 执行器', () => {
  it('按需查资料、多轮回灌，并保留任务人格、模型与生成参数', async () => {
    const { runtime, calls, execute } = setup([
      { answer: '查大纲', toolCalls: [tool('get_outline')] },
      { answer: '少年拔剑。' },
    ]);
    const events: AgentEvent[] = [];
    const result = await runtime.run({ book, messages, model: 'test-model', maxTokens: 800,
      temperature: 0.35, emit: (event) => { events.push(event); } });
    expect(result.answer).toBe('少年拔剑。');
    expect(result.rounds).toBe(2);
    expect(execute).toHaveBeenCalledWith('get_outline', {}, book);
    expect(calls[0].messages[0]).toEqual(messages[0]);
    expect(calls[0]).toMatchObject({ model: 'test-model', maxTokens: 800, temperature: 0.35 });
    expect(calls[1].messages).toContainEqual({ role: 'tool', toolCallId: 'get_outline',
      toolName: 'get_outline', content: '主角正在练剑' });
    expect(events.map((event) => event.type)).toEqual(['step', 'tool_call', 'tool_result']);
    expect(messages).toHaveLength(2);
  });

  it('普通任务即使收到模型伪造的写工具调用也拒绝执行', async () => {
    const { runtime, calls, execute } = setup([
      { answer: '', toolCalls: [tool('save_character', '{"name":"张三"}')] },
      { answer: '少年拔剑。' },
    ]);
    const result = await runtime.run({ book, messages });
    expect(execute).not.toHaveBeenCalled();
    expect(calls[0].tools?.map((spec) => spec.name)).not.toContain('save_character');
    expect(calls[1].messages.at(-1)?.content).toContain('未授权');
    expect(result.trace[0].tools[0].ok).toBe(false);
  });

  it.each(['{坏 JSON', 'null', '[]', '{"name":12}', '{}', '{"name":"张三","extra":1}'])(
    '写工具参数无效时禁止 handler 执行：%s', async (args) => {
      const { runtime, execute, calls } = setup([
        { answer: '', toolCalls: [tool('save_character', args)] }, { answer: '参数有误' },
      ]);
      await runtime.run({ book, messages, allowWrites: true });
      expect(execute).not.toHaveBeenCalled();
      expect(calls[1].messages.at(-1)?.content).toContain('参数无效');
    },
  );

  it('显式 Agent 可执行已授权且参数有效的写工具', async () => {
    const { runtime, execute } = setup([
      { answer: '', toolCalls: [tool('save_character', '{"name":"张三"}')] }, { answer: '已存入' },
    ]);
    await runtime.run({ book, messages, allowWrites: true });
    expect(execute).toHaveBeenCalledWith('save_character', { name: '张三' }, book);
  });

  it('每轮超过三次调用时仍为每个 tool_call 配对结果，避免下一轮请求协议失效', async () => {
    const { runtime, execute, calls } = setup([
      { answer: '', toolCalls: Array.from({ length: 5 }, (_, i) => tool('get_outline', '{}', `c${i}`)) },
      { answer: '完成' },
    ]);
    await runtime.run({ book, messages });
    expect(execute).toHaveBeenCalledTimes(3);
    const results = calls[1].messages.filter((message) => message.role === 'tool');
    expect(results.map((message) => message.toolCallId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(results[3].content).toContain('数量已达上限');
  });

  it('工具异常变为错误结果，模型可继续完成任务', async () => {
    const { runtime, execute, calls } = setup([
      { answer: '', toolCalls: [tool('get_outline')] }, { answer: '暂时没有大纲' },
    ]);
    execute.mockRejectedValueOnce(new Error('数据库暂不可用'));
    const result = await runtime.run({ book, messages });
    expect(result.answer).toBe('暂时没有大纲');
    expect(result.trace[0].tools[0].ok).toBe(false);
    expect(calls[1].messages.at(-1)?.content).toContain('数据库暂不可用');
  });

  it('持续请求工具最多执行四轮，然后去掉工具生成最终结果', async () => {
    const { runtime, execute, calls } = setup([
      ...Array.from({ length: 4 }, () => ({ answer: '', toolCalls: [tool('get_outline')] })),
      { answer: '基于现有资料完成' },
    ]);
    const result = await runtime.run({ book, messages });
    expect(result.rounds).toBe(5);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(calls.at(-1)?.tools).toBeUndefined();
    expect(calls.at(-1)?.messages.at(-1)?.content).toContain('工具调用已达上限');
  });

  it('工具执行期间取消后不执行剩余工具，也不再发起模型调用', async () => {
    const { runtime, execute, llm } = setup([
      { answer: '', toolCalls: [tool('get_outline'), tool('get_outline', '{}', 'second')] },
    ]);
    const controller = new AbortController();
    execute.mockImplementationOnce(async () => {
      controller.abort();
      return { ok: true, content: '取消时刚完成' };
    });
    await expect(runtime.run({ book, messages, signal: controller.signal })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('流式任务发送真实生成块，决策轮的草稿不作为最终 token 输出', async () => {
    const { runtime, llm } = setup([{ answer: '这一段不是最终流式结果' }]);
    const tokens: string[] = [];
    const result = await runtime.run({ book, messages, stream: true, emit: async (event) => {
      if (event.type === 'token') tokens.push(event.text);
    } });
    expect(tokens).toEqual(['少年', '拔剑。']);
    expect(result.answer).toBe('少年拔剑。');
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
  });

  it('不需要工具的抽取任务只有一次模型调用；润色可禁用 RAG 工具', async () => {
    const { runtime, llm, calls } = setup([{ answer: '{}' }]);
    await runtime.run({ book, messages, useTools: false });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(calls[0].tools).toBeUndefined();
    await runtime.run({ book, messages, includeRag: false });
    expect(calls[1].tools?.map((spec) => spec.name)).toEqual(['get_outline']);
  });
});
