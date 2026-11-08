import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeService, type AgentMetrics, type AgentRuntimeOptions } from '../../src/ai/agent/agent-runtime.service';
import { ContextBudgetError } from '../../src/ai/agent/context-budget';
import type { ContextSource } from '../../src/ai/agent/context-sources';
import type { StoryToolsService } from '../../src/ai/agent/story-tools';
import { LlmIncompleteError, recordLlmFailure, type LlmCallOptions, type LlmClient } from '../../src/ai/llm/llm-client.interface';
import { SceneWritingService, type SceneEmit } from '../../src/ai/scene/scene-writing.service';
import type { SceneWriteInput } from '../../src/ai/scene/scene-contract';
import { StoryMemoryService, type StoryMemoryOptions } from '../../src/ai/story-memory.service';
import type { Book } from '../../src/db/schema';

const book = { id: 'book-scene', ownerId: 'server-owner', title: '雨夜城门', description: '旧城中的秘密' } as Book;
const plan = { goal: '沈川拿到城门钥匙', withheld: '不得揭露沈川是王子', pov: '沈川第三人称有限视角', ending: '停在城门打开前', targetChars: 800 };
const input: SceneWriteInput = { book_id: book.id, chapter_id: 'chapter-current', content: '旧稿末尾。',
  intent: '写取钥匙场景', model: 'local:connection/model', plan, auto_repair: true };
const draft = '雨水落下。沈川知道守卫心中暗喜。门还没有打开。';
const issue = { kind: 'pov', constraintId: 'pov', quote: '沈川知道守卫心中暗喜', reason: '越过沈川视角', suggestion: '改为观察守卫动作' };
const review = JSON.stringify({ findings: [issue] });
const repair = JSON.stringify({ edits: [{ id: 'finding-1', replacement: '沈川看见守卫嘴角微动' }] });
const source = (id: string, text: string, version = 'v1'): ContextSource => ({ id, text, version, start: 0, end: text.length });
function metric(status: AgentMetrics['usage']['status'] = 'complete', requestCount = 1, attemptCount = 1,
  knownInputTokens = 10, knownOutputTokens = 5): AgentMetrics {
  return { durationMs: 1, requestCount, attemptCount, toolDurationMs: 0, requests: [],
    usage: { status, knownInputTokens, knownOutputTokens } };
}
type Step = { answer?: string; metrics?: AgentMetrics; error?: Error; beforeReturn?: () => void };
function memoryFixture(sources: ContextSource[] = []) {
  const buildStoryMemory = vi.fn(async (_book: Book, _query: string, _chapter: string | null,
    _content: string | null, options: Partial<StoryMemoryOptions> = {}) => {
    options.onSources?.(sources);
    return '不应整段复用的未筛选记忆';
  });
  return { buildStoryMemory, memory: { buildStoryMemory } as unknown as StoryMemoryService };
}
function setup(script: Step[], sources: ContextSource[] = []) {
  let cursor = 0;
  const calls: AgentRuntimeOptions[] = [];
  const run = vi.fn(async (options: AgentRuntimeOptions) => {
    calls.push(options);
    const step = script[cursor++];
    if (!step) throw new Error('Unexpected extra runtime call');
    if (options.stream) await options.emit?.({ type: 'token', text: step.answer ?? '', runId: 'fake', seq: 1 });
    const metrics = step.metrics ?? metric();
    await options.emit?.({ type: 'run_end', status: step.error ? 'failed' : 'completed', metrics, runId: 'fake', seq: 2 });
    step.beforeReturn?.();
    if (step.error) throw step.error;
    return { answer: step.answer ?? '', metrics, trace: [], rounds: 1, runId: 'fake', proposals: [] };
  });
  const memory = memoryFixture(sources);
  const service = new SceneWritingService({ run } as unknown as AgentRuntimeService, memory.memory);
  const emitted: Array<{ type: string; data: unknown }> = [];
  const emit: SceneEmit = async (type, data) => { emitted.push({ type, data }); };
  const controller = new AbortController();
  return { service, calls, run, ...memory, emitted, emit, controller };
}

describe('scene planning service', () => {
  it('returns a validated editable plan, runtime metrics, and only context/plan stages', async () => {
    const stats = metric();
    const f = setup([{ answer: JSON.stringify(plan), metrics: stats }]);
    const result = await f.service.plan(book, input, f.controller.signal, f.emit);
    expect(result).toEqual({ plan, metrics: stats });
    expect(f.emitted).toEqual([{ type: 'stage', data: { stage: 'context' } }, { type: 'stage', data: { stage: 'plan' } }]);
    expect(f.calls[0]).toMatchObject({ book, model: input.model, useTools: false, maxTokens: 1800,
      temperature: 0.25, signal: f.controller.signal });
  });

  it.each(['{invalid', '{}', '{"goal":"only goal"}', JSON.stringify({ ...plan, extra: true }),
    `以下是计划：${JSON.stringify(plan)}`])('rejects malformed structured planning output: %s', async (answer) => {
    const f = setup([{ answer }]);
    await expect(f.service.plan(book, input, f.controller.signal, f.emit)).rejects.toThrow('未生成可应用结果');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.emitted.every(e => e.type === 'stage')).toBe(true);
  });
});

describe('scene writing orchestration', () => {
  it('builds memory once and passes confirmed goals, withheld information and POV to draft, review and repair', async () => {
    const char = source('character:shen', '沈川不会游泳');
    const f = setup([{ answer: draft }, { answer: review }, { answer: repair }], [char, char,
      source('outline:future', '未来才渡河'), source('chapter:past', '老人声称门后有人')]);
    const result = await f.service.write(book, input, f.controller.signal, f.emit);
    expect(result).toMatchObject({ plan, draft, revised: draft.replace(issue.quote, '沈川看见守卫嘴角微动'), repairApplied: true });
    expect(result.warnings.join('')).toContain('未再次调用模型审阅');
    expect(f.buildStoryMemory).toHaveBeenCalledTimes(1);
    expect(f.buildStoryMemory).toHaveBeenCalledWith(book, expect.stringContaining(plan.goal), input.chapter_id, null,
      expect.objectContaining({ previousChapterLimit: 2, previousChapterChars: 500, characterLimit: 6,
        outlineLimit: 3, currentChars: 0, includeRag: true, signal: f.controller.signal,
        focusQuery: expect.stringContaining(input.content) }));
    for (const call of f.calls) {
      const prompt = call.messages.map(m => m.content).join('\n');
      for (const text of [plan.goal, plan.withheld, plan.pov, plan.ending, input.intent, book.description]) expect(prompt).toContain(text);
      expect(call).toMatchObject({ book, model: input.model, signal: f.controller.signal, useTools: false });
      expect(prompt).not.toContain('不应整段复用的未筛选记忆');
    }
    expect(f.calls.map(c => c.maxTokens)).toEqual([4096, 2600, 2600]);
    expect(f.calls.map(c => c.temperature)).toEqual([0.7, 0.2, 0.2]);
    expect(f.calls.map(c => !!c.stream)).toEqual([true, false, false]);
    const table = JSON.parse(f.calls[1].messages[1].content.split('【约束表】\n')[1].split('\n【新增正文】')[0]);
    expect(table.filter((c: { text: string }) => c.text === char.text)).toEqual([
      { id: 'source:1', text: char.text, authoritative: true },
    ]);
    expect(table.find((c: { id: string }) => c.id === 'source:2').authoritative).toBe(false);
    expect(table.find((c: { id: string }) => c.id === 'source:3').authoritative).toBe(false);
    expect(table.find((c: { id: string }) => c.id === 'source:draft').authoritative).toBe(false);
    expect(f.emitted.filter(e => e.type === 'stage').map(e => e.data)).toEqual(
      ['context', 'draft', 'review', 'repair'].map(stage => ({ stage })));
    expect(f.emitted.filter(e => e.type === 'token')).toEqual([{ type: 'token', data: { text: draft } }]);
  });

  it('uses the last 1200 code points of the draft, preserves source versions, and reuses the same context for repair', async () => {
    const f = setup([{ answer: draft }, { answer: review }, { answer: repair }], [
      source('chapter:same', '旧版本', 'v1'), source('chapter:same', '新版本', 'v2'),
    ]);
    await f.service.write(book, { ...input, content: '不要保留的前缀' + '🌧'.repeat(1200) }, f.controller.signal, f.emit);
    const first = f.calls[0].messages[1].content;
    expect(first).not.toContain('不要保留的前缀');
    expect(first).toContain('🌧'.repeat(1200));
    expect(first).toContain('旧版本');
    expect(first).toContain('新版本');
    expect(f.calls[2].messages[1].content).toContain(first);
  });

  it.each([
    { name: 'repair disabled', auto_repair: false, findings: [issue] },
    { name: 'no findings', auto_repair: true, findings: [] },
    { name: 'goal advice', auto_repair: true, findings: [{ ...issue, kind: 'goal', constraintId: 'goal' }] },
    { name: 'style advice', auto_repair: true, findings: [{ ...issue, kind: 'style', constraintId: 'style' }] },
    { name: 'invented evidence', auto_repair: true, findings: [{ ...issue, quote: '从未出现的句子' }] },
  ])('returns the reviewed draft with no extra call for $name', async ({ auto_repair, findings }) => {
    const f = setup([{ answer: draft }, { answer: JSON.stringify({ findings }) }]);
    const result = await f.service.write(book, { ...input, auto_repair }, f.controller.signal, f.emit);
    expect(result).toMatchObject({ draft, revised: draft, repairApplied: false });
    expect(f.run).toHaveBeenCalledTimes(2);
    if (findings[0]?.quote === '从未出现的句子') expect(result.warnings.join('')).toContain('1 条意见');
  });

  it('allows only three findings and at most 1200 quoted characters in one repair call, never rereviews', async () => {
    const quotes = ['甲'.repeat(500), '乙'.repeat(500), '丙'.repeat(500), '丁'.repeat(10)];
    const text = quotes.join('\n');
    const f = setup([{ answer: text }, { answer: JSON.stringify({ findings: quotes.map(quote => ({ ...issue, quote })) }) },
      { answer: '{"edits":[]}' }]);
    const result = await f.service.write(book, input, f.controller.signal, f.emit);
    expect(result.findings).toHaveLength(4);
    const allowed = JSON.parse(f.calls[2].messages[1].content.split('【允许修订的片段及意见】\n')[1]);
    expect(allowed.map((f: { id: string }) => f.id)).toEqual(['finding-1', 'finding-2']);
    expect(allowed.reduce((n: number, f: { quote: string }) => n + f.quote.length, 0)).toBeLessThanOrEqual(1200);
    expect(f.run).toHaveBeenCalledTimes(3);
  });

  it('caps even short repairable findings at three', async () => {
    const quotes = ['甲片段', '乙片段', '丙片段', '丁片段'];
    const f = setup([{ answer: quotes.join('。') },
      { answer: JSON.stringify({ findings: quotes.map(quote => ({ ...issue, quote })) }) }, { answer: '{"edits":[]}' }]);
    await f.service.write(book, input, f.controller.signal, f.emit);
    const allowed = JSON.parse(f.calls[2].messages[1].content.split('【允许修订的片段及意见】\n')[1]);
    expect(allowed).toHaveLength(3);
    expect(f.run).toHaveBeenCalledTimes(3);
  });

  it.each(['{bad', '{}', '{"findings":null}', JSON.stringify({ findings: [{ ...issue, suggestion: undefined }] })])(
    'review parse failure exposes no applicable service result: %s', async (answer) => {
      const f = setup([{ answer: draft }, { answer }]);
      await expect(f.service.write(book, input, f.controller.signal, f.emit)).rejects.toThrow('未生成可应用结果');
      expect(f.run).toHaveBeenCalledTimes(2);
    });

  it.each(['draft', 'review'])('propagates incomplete %s instead of returning an applicable result', async (stage) => {
    const error = new LlmIncompleteError('length');
    const f = setup(stage === 'draft' ? [{ error }] : [{ answer: draft }, { error }]);
    await expect(f.service.write(book, input, f.controller.signal, f.emit)).rejects.toBe(error);
    expect(f.run).toHaveBeenCalledTimes(stage === 'draft' ? 1 : 2);
  });

  it.each(['', '   ', '甲'.repeat(5001)])('rejects empty or oversized drafts before review', async (answer) => {
    const f = setup([{ answer }]);
    await expect(f.service.write(book, input, f.controller.signal, f.emit)).rejects.toThrow('场景正文为空或超出单场景范围');
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'network error', step: { error: new Error('repair network failed') } },
    { name: 'incomplete repair', step: { error: new LlmIncompleteError('length') } },
    { name: 'malformed JSON', step: { answer: '{bad' } },
    { name: 'unknown finding', step: { answer: '{"edits":[{"id":"fake","replacement":"x"}]}' } },
    { name: 'valid edit then invalid edit', step: { answer: '{"edits":[{"id":"finding-1","replacement":"valid"},{"id":"fake","replacement":"x"}]}' } },
    { name: 'replacement overflow', step: { answer: JSON.stringify({ edits: [{ id: 'finding-1', replacement: '甲'.repeat(301) }] }) } },
  ])('preserves the entire reviewed draft on $name', async ({ step }) => {
    const f = setup([{ answer: draft }, { answer: review }, step]);
    const result = await f.service.write(book, input, f.controller.signal, f.emit);
    expect(result).toMatchObject({ draft, revised: draft, repairApplied: false });
    expect(result.warnings.join('')).toContain('已保留审阅过的初稿');
    expect(f.run).toHaveBeenCalledTimes(3);
  });

  it.each(['context', 'draft', 'review', 'repair', 'repair-error', 'plan'])('always propagates cancellation during %s', async (stage) => {
    const controller = new AbortController();
    const reason = new Error(`cancel ${stage}`);
    const cancel = () => controller.abort(reason);
    const steps: Step[] = [{ answer: draft }, { answer: review }, { answer: repair }];
    if (stage === 'plan') steps.splice(0, steps.length, { answer: JSON.stringify(plan), beforeReturn: cancel });
    else if (stage !== 'context') {
      const index = stage === 'draft' ? 0 : stage === 'review' ? 1 : 2;
      steps[index].beforeReturn = cancel;
      if (stage === 'repair-error') steps[index].error = new Error('upstream abort');
    }
    const f = setup(steps);
    if (stage === 'context') f.buildStoryMemory.mockImplementationOnce(async () => { cancel(); return ''; });
    const call = stage === 'plan' ? f.service.plan(book, input, controller.signal, f.emit)
      : f.service.write(book, input, controller.signal, f.emit);
    await expect(call).rejects.toBe(reason);
    expect(f.run.mock.calls.length).toBe(stage === 'context' ? 0 : stage === 'draft' || stage === 'plan' ? 1 : stage === 'review' ? 2 : 3);
  });

  it.each([
    ['complete', ['complete', 'complete', 'complete']], ['partial', ['complete', 'unknown', 'partial']],
    ['unknown', ['unknown', 'unknown', 'unknown']],
  ] as const)('aggregates requests, retries and known usage with %s coverage including a failed repair', async (status, coverage) => {
    const f = setup([
      { answer: draft, metrics: metric(coverage[0], 1, 2, 11, 7) },
      { answer: review, metrics: metric(coverage[1], 1, 1, 13, 5) },
      { error: new Error('failed repair'), metrics: metric(coverage[2], 1, 3, 17, 3) },
    ]);
    const result = await f.service.write(book, input, f.controller.signal, f.emit);
    expect(result.metrics).toMatchObject({ durationMs: expect.any(Number), requestCount: 3, attemptCount: 6,
      usage: { status, knownInputTokens: 41, knownOutputTokens: 15 } });
    expect(result.metrics.stages.map(s => s.stage)).toEqual(['draft', 'review', 'repair']);
    expect(result.revised).toBe(draft);
  });
});

describe('scene service delegates owner routing, budgets and failed-call accounting to the real runtime', () => {
  function actualRuntime(contextWindow = 32768) {
    const calls: LlmCallOptions[] = [];
    const chat = vi.fn(async (options: LlmCallOptions) => {
      calls.push(options);
      return { answer: JSON.stringify(plan), finishReason: 'stop' as const };
    });
    const modelCapabilities = vi.fn(async () => ({ tools: true, contextWindow }));
    const llm: LlmClient = { chat, chatStream: vi.fn(), embed: vi.fn(), modelCapabilities };
    const execute = vi.fn();
    const tools = { specs: [{ name: 'get_outline', description: 'read outline', parameters: { type: 'object' } }], execute } as unknown as StoryToolsService;
    const runtime = new AgentRuntimeService(llm, tools);
    const memory = memoryFixture();
    return { service: new SceneWritingService(runtime, memory.memory), calls, chat, llm, execute, modelCapabilities };
  }

  it('passes the authorized book owner/model, omits tools, and applies provider output-window limits', async () => {
    const f = actualRuntime(16000);
    const emit: SceneEmit = async () => undefined;
    await f.service.plan(book, input, new AbortController().signal, emit);
    expect(f.modelCapabilities).toHaveBeenCalledWith(input.model, book.ownerId);
    expect(f.calls[0]).toMatchObject({ accountId: book.ownerId, model: input.model, maxTokens: 1800 });
    expect(f.calls[0].tools).toBeUndefined();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('caps all generation stages to the discovered provider context window', async () => {
    const f = actualRuntime(10000);
    f.llm.streamEvents = async function* (options) {
      f.calls.push(options);
      yield { type: 'text', text: draft };
      yield { type: 'done', result: { answer: draft, finishReason: 'stop' } };
    };
    f.chat.mockImplementationOnce(async options => {
      f.calls.push(options);
      return { answer: review, finishReason: 'stop' };
    }).mockImplementationOnce(async options => {
      f.calls.push(options);
      return { answer: repair, finishReason: 'stop' };
    });
    const result = await f.service.write(book, input, new AbortController().signal, async () => undefined);
    expect(result.repairApplied).toBe(true);
    expect(f.calls.map(call => call.maxTokens)).toEqual([2500, 2500, 2500]);
    expect(f.calls.every(call => call.accountId === book.ownerId && !call.tools)).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('enforces runtime input budgets before sending an oversized task upstream', async () => {
    const f = actualRuntime(1024);
    const emit: SceneEmit = async () => undefined;
    await expect(f.service.plan(book, { ...input, intent: '长'.repeat(1200) }, new AbortController().signal, emit)).rejects.toBeInstanceOf(ContextBudgetError);
    expect(f.chat).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('counts actual failed repair retries and known usage emitted from runtime finally', async () => {
    const f = actualRuntime();
    f.llm.streamEvents = async function* (options) {
      f.calls.push(options);
      yield { type: 'text', text: draft };
      yield { type: 'done', result: { answer: draft, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 4 } } };
    };
    const failure = new Error('repair retries exhausted');
    recordLlmFailure(failure, [
      { durationMs: 1, status: 'failed' },
      { durationMs: 2, status: 'failed', usage: { inputTokens: 8, outputTokens: 2 } },
    ]);
    f.chat.mockImplementationOnce(async options => {
      f.calls.push(options);
      return { answer: review, finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 6 } };
    }).mockRejectedValueOnce(failure);
    const result = await f.service.write(book, input, new AbortController().signal, async () => undefined);
    expect(result).toMatchObject({ revised: draft, repairApplied: false, metrics: { requestCount: 3, attemptCount: 4,
      usage: { status: 'partial', knownInputTokens: 38, knownOutputTokens: 12 } } });
    expect(result.metrics.stages[2].metrics.requests[0].attempts).toHaveLength(2);
  });
});
