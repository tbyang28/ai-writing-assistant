import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeService, type AgentEvent } from '../../src/ai/agent/agent-runtime.service';
import { StoryToolsService, type ToolExecResult } from '../../src/ai/agent/story-tools';
import type { ContextSource } from '../../src/ai/agent/context-sources';
import { ContextBudgetError } from '../../src/ai/agent/context-budget';
import { LlmIncompleteError, recordLlmFailure, type LlmAttempt, type LlmCallOptions,
  type LlmClient, type LlmResult, type LlmStreamEvent } from '../../src/ai/llm/llm-client.interface';
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
  const execute = vi.fn(async (): Promise<ToolExecResult> => ({ ok: true, content: '主角正在练剑' }));
  const isConcurrencySafe = vi.fn(() => false);
  const tools = { specs, execute, isConcurrencySafe } as unknown as StoryToolsService;
  return { runtime: new AgentRuntimeService(llm, tools), calls, execute, llm, isConcurrencySafe };
}

function tool(name: string, args = '{}', id = name) {
  return { id, name, argumentsJson: args };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setupStream(script: LlmStreamEvent[][]) {
  const fixture = setup([]);
  let index = 0;
  const streamEvents = vi.fn(async function* (options: LlmCallOptions) {
    fixture.calls.push(options);
    const events = script[index++];
    if (!events) throw new Error('Unexpected additional model request');
    yield* events;
  });
  fixture.llm.streamEvents = streamEvents;
  return { ...fixture, streamEvents };
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
    expect(execute).toHaveBeenCalledWith('get_outline', {}, book, undefined);
    expect(calls[0].messages[0]).toEqual(messages[0]);
    expect(calls[0]).toMatchObject({ model: 'test-model', maxTokens: 800, temperature: 0.35 });
    expect(calls[1].messages).toContainEqual({ role: 'tool', toolCallId: 'get_outline',
      toolName: 'get_outline', content: '主角正在练剑' });
    expect(events.map((event) => event.type)).toEqual(['run_start', 'step', 'tool_call', 'tool_result', 'run_end']);
    expect(new Set(events.map((event) => event.runId)).size).toBe(1);
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
    expect(execute).toHaveBeenCalledWith('save_character', { name: '张三' }, book, undefined);
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

  it.each([true, false])('生产 streamEvents 无工具调用时只请求一次（useTools=%s）', async (useTools) => {
    const response: LlmResult = { answer: '少年拔剑。', finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 4 } };
    const { runtime, streamEvents, llm, execute, calls } = setupStream([[
      { type: 'text', text: '少年' }, { type: 'text', text: '拔剑。' },
      { type: 'done', result: response },
    ]]);
    const events: AgentEvent[] = [];
    const result = await runtime.run({ book, messages, stream: true, useTools,
      emit: (event) => { events.push(event); } });
    expect(streamEvents).toHaveBeenCalledTimes(1);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(llm.chatStream).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(Boolean(calls[0].tools?.length)).toBe(useTools);
    expect(events.filter((event) => event.type === 'token').map((event) => event.text))
      .toEqual(['少年', '拔剑。']);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((event) => event.runId === result.runId)).toBe(true);
    expect(result).toMatchObject({ answer: response.answer, rounds: 1,
      metrics: { requestCount: 1, attemptCount: 1, usage: { status: 'complete', inputTokens: 12, outputTokens: 4 } } });
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'completed',
      metrics: { requestCount: 1, attemptCount: 1, usage: result.metrics.usage, requests: result.metrics.requests,
        durationMs: expect.any(Number) } });
  });

  it('工具参数增量未完成时不执行；完成后只执行终态参数，工具轮文本不进入正文', async () => {
    const { runtime, llm, execute, calls } = setup([]);
    const atPartial = deferred();
    const finishArguments = deferred();
    const events: AgentEvent[] = [];
    let streamClosed = false;
    let request = 0;
    const streamEvents = vi.fn(async function* (options: LlmCallOptions): AsyncGenerator<LlmStreamEvent> {
      calls.push(options);
      if (request++ === 0) {
        yield { type: 'text', text: '先查找练剑情节。' };
        yield { type: 'tool_call_delta', index: 0, id: 'search-1', name: 'search_story', arguments: '{"query":"练' };
        atPartial.resolve();
        await finishArguments.promise;
        yield { type: 'tool_call_delta', index: 0, arguments: '剑"}' };
        expect(execute).not.toHaveBeenCalled();
        yield { type: 'done', result: { answer: '先查找练剑情节。', finishReason: 'tool_calls',
          toolCalls: [tool('search_story', '{"query":"练剑"}', 'search-1')] } };
        streamClosed = true;
      } else {
        yield { type: 'text', text: '少年拔剑。' };
        yield { type: 'done', result: { answer: '少年拔剑。', finishReason: 'stop' } };
      }
    });
    llm.streamEvents = streamEvents;
    execute.mockImplementation(async () => {
      expect(streamClosed).toBe(true);
      return { ok: true, content: '前文：少年持剑站定。' };
    });
    const running = runtime.run({ book, messages, stream: true,
      emit: (event) => { events.push(event); } });
    await atPartial.promise;
    try {
      expect(execute).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === 'tool_call' || event.type === 'token')).toBe(false);
    } finally { finishArguments.resolve(); }
    const result = await running;
    expect(execute).toHaveBeenCalledExactlyOnceWith('search_story', { query: '练剑' }, book, undefined);
    expect(streamEvents).toHaveBeenCalledTimes(2);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(llm.chatStream).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'token').map((event) => event.text)).toEqual(['少年拔剑。']);
    expect(result.answer).toBe('少年拔剑。');
    expect(calls[1].messages).toContainEqual({ role: 'tool', toolName: 'search_story',
      toolCallId: 'search-1', content: '前文：少年持剑站定。' });
  });

  it.each([true, false])('length 即使携带有效工具调用也零执行（stream=%s）', async (stream) => {
    const truncated: LlmResult = { answer: '未完成的工具轮文本', finishReason: 'length',
      toolCalls: [tool('get_outline', '{}', 'valid-call')] };
    const fixture = stream ? setupStream([[
      { type: 'text', text: truncated.answer },
      { type: 'tool_call_delta', index: 0, id: 'valid-call', name: 'get_outline', arguments: '{}' },
      { type: 'done', result: truncated },
    ]]) : setup([truncated]);
    const events: AgentEvent[] = [];
    await expect(fixture.runtime.run({ book, messages, stream,
      emit: (event) => { events.push(event); } })).rejects.toMatchObject({ name: 'LlmIncompleteError', reason: 'length' });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.calls).toHaveLength(1);
    expect(events.some((event) => ['token', 'tool_call', 'tool_result'].includes(event.type))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'failed',
      metrics: { requestCount: 1, attemptCount: 1 } });
  });

  it('生产流缺少 done 时拒绝半成品且不执行增量工具', async () => {
    const { runtime, execute } = setupStream([[
      { type: 'text', text: '半成品' },
      { type: 'tool_call_delta', index: 0, id: 'unfinished', name: 'get_outline', arguments: '{}' },
    ]]);
    const events: AgentEvent[] = [];
    await expect(runtime.run({ book, messages, stream: true,
      emit: (event) => { events.push(event); } })).rejects.toBeInstanceOf(LlmIncompleteError);
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'token')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'failed',
      metrics: { usage: { status: 'unknown' } } });
  });

  it.each([
    { label: '所有请求用量完整并按字段相加',
      responses: [{ usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, reasoningTokens: 1 } },
        { usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 5, reasoningTokens: 2 } }],
      expected: { status: 'complete', inputTokens: 30, outputTokens: 6, knownInputTokens: 30,
        knownOutputTokens: 6, cachedInputTokens: 8, reasoningTokens: 3 }, attemptCount: 2 },
    { label: '完整的零用量不会当作未知',
      responses: [{ usage: { inputTokens: 0, outputTokens: 0 } }, { usage: { inputTokens: 0, outputTokens: 0 } }],
      expected: { status: 'complete', inputTokens: 0, outputTokens: 0, knownInputTokens: 0, knownOutputTokens: 0 }, attemptCount: 2 },
    { label: '部分请求没有用量只暴露已知小计',
      responses: [{ usage: { inputTokens: 10, outputTokens: 2 } }, {}],
      expected: { status: 'partial', knownInputTokens: 10, knownOutputTokens: 2 }, attemptCount: 2 },
    { label: '单个字段缺失时不伪造该字段总量',
      responses: [{ usage: { inputTokens: 10, outputTokens: 2 } }, { usage: { inputTokens: 20 } }],
      expected: { status: 'partial', inputTokens: 30, knownInputTokens: 30, knownOutputTokens: 2 }, attemptCount: 2 },
    { label: '失败重试用量未知时总体仍为 partial，最终 usage 不重复计入',
      responses: [{ usage: { inputTokens: 999, outputTokens: 999 }, attempts: [
        { status: 'failed' as const, durationMs: 1 },
        { status: 'completed' as const, durationMs: 2, usage: { inputTokens: 10, outputTokens: 2 } },
      ] }, { usage: { inputTokens: 20, outputTokens: 4 } }],
      expected: { status: 'partial', knownInputTokens: 30, knownOutputTokens: 6 }, attemptCount: 3 },
    { label: '所有请求未报告用量时标记 unknown', responses: [{}, {}],
      expected: { status: 'unknown', knownInputTokens: 0, knownOutputTokens: 0 }, attemptCount: 2 },
  ])('usage：$label', async ({ responses, expected, attemptCount }) => {
    const { runtime } = setup([
      { answer: '', toolCalls: [tool('get_outline')], ...responses[0] },
      { answer: '完成', ...responses[1] },
    ]);
    const events: AgentEvent[] = [];
    const result = await runtime.run({ book, messages, emit: (event) => { events.push(event); } });
    expect(result.metrics).toMatchObject({ requestCount: 2, attemptCount });
    expect(result.metrics.usage).toEqual(expected);
    expect(events.at(-1)).toMatchObject({ type: 'run_end', metrics: { usage: expected, requestCount: 2, attemptCount } });
  });

  it.each([true, false])('上游最终失败时计入全部失败重试及已知用量，并保留原异常（stream=%s）', async (stream) => {
    const { runtime, llm, execute } = setup([]);
    const original = new Error('上游重试耗尽');
    const attempts: LlmAttempt[] = [
      { status: 'failed', durationMs: 11 },
      { status: 'failed', durationMs: 22, usage: { inputTokens: 4, outputTokens: 2 } },
      { status: 'failed', durationMs: 33, usage: { inputTokens: 6, outputTokens: 3 } },
    ];
    recordLlmFailure(original, attempts);
    vi.mocked(llm.chat).mockRejectedValueOnce(original);
    const streamEvents = vi.fn(async function* (): AsyncGenerator<LlmStreamEvent> { throw original; });
    llm.streamEvents = streamEvents;
    const events: AgentEvent[] = [];
    await expect(runtime.run({ book, messages, stream,
      emit: (event) => { events.push(event); } })).rejects.toBe(original);
    expect(streamEvents).toHaveBeenCalledTimes(stream ? 1 : 0);
    expect(llm.chat).toHaveBeenCalledTimes(stream ? 0 : 1);
    expect(llm.chatStream).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: 'run_end', status: 'failed',
      metrics: { requestCount: 1, attemptCount: 3,
        requests: [{ finishReason: 'error', attempts }] } });
    if (terminal?.type !== 'run_end') throw new Error('Missing run_end event');
    expect(terminal.metrics.requests).toHaveLength(1);
    expect(terminal.metrics.usage).toEqual({ status: 'partial', knownInputTokens: 10, knownOutputTokens: 5 });
  });

  it.each([true, false])('本地 prepareContext 预算拒绝不计上游请求或尝试次数（stream=%s）', async (stream) => {
    const { runtime, llm, execute } = setup([]);
    const streamEvents = vi.fn(async function* (): AsyncGenerator<LlmStreamEvent> {
      throw new Error('预算拒绝后不应调用上游');
    });
    llm.streamEvents = streamEvents;
    const events: AgentEvent[] = [];
    await expect(runtime.run({ book, messages, stream, maxTokens: 32,
      contextBudget: { contextWindow: 64, headroomTokens: 0 },
      emit: (event) => { events.push(event); } })).rejects.toBeInstanceOf(ContextBudgetError);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(llm.chatStream).not.toHaveBeenCalled();
    expect(streamEvents).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['run_start', 'run_end']);
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'failed',
      metrics: { requestCount: 0, attemptCount: 0, requests: [],
        usage: { status: 'unknown', knownInputTokens: 0, knownOutputTokens: 0 } } });
  });

  it.each([true, false])('run_end 异步传输失败不覆盖原上游异常（stream=%s）', async (stream) => {
    const { runtime, llm } = setup([]);
    const original = new Error('原始上游异常');
    const deliveryError = new Error('run_end 连接已断开');
    vi.mocked(llm.chat).mockRejectedValueOnce(original);
    llm.streamEvents = vi.fn(async function* (): AsyncGenerator<LlmStreamEvent> { throw original; });
    const events: AgentEvent[] = [];
    const emit = vi.fn(async (event: AgentEvent) => {
      events.push(event);
      if (event.type === 'run_end') throw deliveryError;
    });
    await expect(runtime.run({ book, messages, stream, emit })).rejects.toBe(original);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual(['run_start', 'run_end']);
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'failed',
      metrics: { requestCount: 1, attemptCount: 1, requests: [{ finishReason: 'error' }] } });
  });

  it('同名工具并行乱序完成时，事件用 callId 配对，回灌结果保持模型调用顺序', async () => {
    const { runtime, execute, isConcurrencySafe, calls } = setup([
      { answer: '', toolCalls: [tool('get_outline', '{}', 'outline-a'), tool('get_outline', '{}', 'outline-b')] },
      { answer: '完成' },
    ]);
    const first = deferred();
    const secondCompleted = deferred();
    const events: AgentEvent[] = [];
    isConcurrencySafe.mockReturnValue(true);
    execute.mockImplementationOnce(async () => { await first.promise; return { ok: true, content: '第一份大纲' }; });
    execute.mockImplementationOnce(async () => ({ ok: false, content: '第二份读取失败' }));
    const running = runtime.run({ book, messages, toolConcurrency: 2, emit: (event) => {
      events.push(event);
      if (event.type === 'tool_result' && event.callId === 'outline-b') secondCompleted.resolve();
    } });
    await secondCompleted.promise;
    first.resolve();
    const result = await running;
    const toolEvents = events.filter((event) => event.type === 'tool_call' || event.type === 'tool_result');
    expect(toolEvents).toMatchObject([
      { type: 'tool_call', name: 'get_outline', callId: 'outline-a' },
      { type: 'tool_call', name: 'get_outline', callId: 'outline-b' },
      { type: 'tool_result', name: 'get_outline', callId: 'outline-b', status: 'failed', ok: false, preview: '第二份读取失败' },
      { type: 'tool_result', name: 'get_outline', callId: 'outline-a', status: 'completed', ok: true, preview: '第一份大纲' },
    ]);
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
    expect(events.every((event) => event.runId === result.runId)).toBe(true);
    expect(calls[1].messages.filter((message) => message.role === 'tool')).toEqual([
      { role: 'tool', toolName: 'get_outline', toolCallId: 'outline-a', content: '第一份大纲' },
      { role: 'tool', toolName: 'get_outline', toolCallId: 'outline-b', content: '第二份读取失败' },
    ]);
  });

  it('initialSources 去掉同版本已包含范围，保留新版和新范围且不修改调用方来源', async () => {
    const initialSources: ContextSource[] = [
      { id: 'chapter-1', version: 'v1', start: 0, end: 100, text: '作品记忆已提供' },
    ];
    const sources: ContextSource[] = [
      { id: 'chapter-1', version: 'v1', start: 20, end: 40, text: '不应重复注入' },
      { id: 'chapter-1', version: 'v2', start: 20, end: 40, text: '更新后的章节片段' },
      { id: 'chapter-1', version: 'v1', start: 100, end: 120, text: '未覆盖的章节片段' },
    ];
    const original = structuredClone(initialSources);
    const { runtime, execute, calls } = setup([
      { answer: '', toolCalls: [tool('get_outline', '{}', 'source-call')] }, { answer: '完成' },
    ]);
    execute.mockResolvedValueOnce({ ok: true, content: sources.map((source) => source.text).join('\n'), sources });
    await runtime.run({ book, messages, initialSources });
    expect(calls[1].messages.find((message) => message.toolCallId === 'source-call')?.content)
      .toBe('更新后的章节片段\n\n未覆盖的章节片段');
    expect(initialSources).toEqual(original);
  });

  it('initialSources 完全覆盖时保留工具配对及引用提示，来源去重不跨运行泄漏', async () => {
    const source: ContextSource = { id: 'outline-1', version: 'v1', start: 0, end: 20, text: '完整大纲' };
    const { runtime, execute, calls } = setup([
      { answer: '', toolCalls: [tool('get_outline', '{}', 'initial-covered')] }, { answer: '完成' },
      { answer: '', toolCalls: [tool('get_outline', '{}', 'new-run')] }, { answer: '完成' },
    ]);
    execute.mockResolvedValue({ ok: true, content: source.text, sources: [source] });
    await runtime.run({ book, messages, initialSources: [source] });
    expect(calls[1].messages.find((message) => message.toolCallId === 'initial-covered')).toMatchObject({
      role: 'tool', toolName: 'get_outline', content: '（同版本、同范围资料已在本次上下文中，请引用已有资料）',
    });
    await runtime.run({ book, messages });
    expect(calls[3].messages.find((message) => message.toolCallId === 'new-run')?.content).toBe(source.text);
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
