import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLlmFailureAttempts, LlmIncompleteError, type LlmCallOptions, type LlmResult,
  type LlmStreamEvent } from '../../src/ai/llm/llm-client.interface';
import { RoutedLlmClient } from '../../src/ai/llm/routed-llm.client';
import type { SiliconFlowClient } from '../../src/ai/llm/silicon-flow.client';
import type { LocalJobBroker } from '../../src/local-providers/local-job-broker';
import type { LocalProvidersService } from '../../src/local-providers/local-providers.service';
import { localModelKey } from '../../src/local-providers/protocol';

const connectionId = '00000000-0000-4000-8000-000000000001';
const localModel = localModelKey(connectionId, 'ollama', 'qwen/author:8b');
const tool = { name: 'read_chapter', description: '读取章节', parameters: { type: 'object' } };
const options = (): LlmCallOptions => ({
  model: localModel, accountId: 'owner-1', messages: [{ role: 'user', content: '请续写' }],
});
async function* events(items: LlmStreamEvent[]): AsyncIterable<LlmStreamEvent> { yield* items; }
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe('RoutedLlmClient', () => {
  let router: RoutedLlmClient;
  let cloud: {
    chat: ReturnType<typeof vi.fn>;
    chatStream: ReturnType<typeof vi.fn>;
    streamEvents: ReturnType<typeof vi.fn>;
    embed: ReturnType<typeof vi.fn>;
  };
  let providers: { resolve: ReturnType<typeof vi.fn> };
  let jobs: { run: ReturnType<typeof vi.fn> };

  function expectNoCloudGeneration() {
    expect(cloud.chat).not.toHaveBeenCalled();
    expect(cloud.chatStream).not.toHaveBeenCalled();
    expect(cloud.streamEvents).not.toHaveBeenCalled();
  }
  beforeEach(() => {
    cloud = {
      chat: vi.fn(async () => ({ answer: 'cloud', finishReason: 'stop' })),
      chatStream: vi.fn(() => (async function* () { yield 'cloud'; })()),
      streamEvents: vi.fn(() => events([{ type: 'text', text: 'cloud' },
        { type: 'done', result: { answer: 'cloud', finishReason: 'stop' } }])),
      embed: vi.fn(async () => [[0.1, 0.2]]),
    };
    providers = { resolve: vi.fn(async () => ({ connectionId, provider: 'ollama', model: 'qwen/author:8b',
      tools: true, contextWindow: 32768 })) };
    jobs = { run: vi.fn(() => events([{ type: 'text', text: '本机正文' },
      { type: 'done', result: { answer: '本机正文', finishReason: 'stop' } }])) };
    router = new RoutedLlmClient(cloud as unknown as SiliconFlowClient,
      providers as unknown as LocalProvidersService, jobs as unknown as LocalJobBroker);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([undefined, 'deepseek-ai/DeepSeek-V4-Flash'])('delegates cloud chat unchanged for model %j', async (model) => {
    const request = { ...options(), model, tools: [tool], signal: new AbortController().signal };
    const result: LlmResult = { answer: 'cloud', finishReason: 'length', attempts: [{ status: 'completed', durationMs: 3 }] };
    cloud.chat.mockResolvedValue(result);
    expect(await router.chat(request)).toBe(result);
    expect(cloud.chat).toHaveBeenCalledExactlyOnceWith(request);
    expect(cloud.chat.mock.calls[0][0]).toBe(request);
    expect(providers.resolve).not.toHaveBeenCalled();
    expect(jobs.run).not.toHaveBeenCalled();
  });

  it('delegates cloud text and event streams without filtering terminals or metadata', async () => {
    const request = { ...options(), model: 'cloud-model' };
    const terminal: LlmStreamEvent = { type: 'done', result: { answer: 'cloud', finishReason: 'length',
      usage: { outputTokens: 4 }, attempts: [{ status: 'completed', durationMs: 2 }] } };
    cloud.streamEvents.mockImplementation(() => events([terminal]));
    expect(await collect(router.chatStream(request))).toEqual(['cloud']);
    expect(await collect(router.streamEvents(request))).toEqual([terminal]);
    expect(cloud.chatStream).toHaveBeenCalledExactlyOnceWith(request);
    expect(cloud.streamEvents).toHaveBeenCalledExactlyOnceWith(request);
    expect(providers.resolve).not.toHaveBeenCalled();
    expect(jobs.run).not.toHaveBeenCalled();
  });

  it('preserves cloud errors and their attempts without starting a local job', async () => {
    const error = new Error('cloud unavailable');
    cloud.chat.mockRejectedValue(error);
    await expect(router.chat({ ...options(), model: 'cloud' })).rejects.toBe(error);
    expect(jobs.run).not.toHaveBeenCalled();
  });

  it('reports cloud and local model capabilities, resolving the current account every time', async () => {
    providers.resolve.mockResolvedValueOnce(null).mockResolvedValueOnce({ tools: false, contextWindow: 8192 });
    expect(await router.modelCapabilities('cloud', 'owner-1')).toEqual({ tools: true });
    expect(await router.modelCapabilities(localModel, 'owner-1')).toEqual({ tools: false, contextWindow: 8192 });
    expect(providers.resolve.mock.calls).toEqual([['owner-1', 'cloud'], ['owner-1', localModel]]);
    expect(jobs.run).not.toHaveBeenCalled();
    expectNoCloudGeneration();
  });

  it('propagates authorization or connection errors when checking local capabilities', async () => {
    const error = new Error('本机连接器已离线');
    providers.resolve.mockRejectedValue(error);
    await expect(router.modelCapabilities(localModel, 'other-owner')).rejects.toBe(error);
    expectNoCloudGeneration();
  });

  it('dispatches the resolved model, defaults, messages and abort signal with no cloud call', async () => {
    const request = { ...options(), signal: new AbortController().signal };
    const result = await router.chat(request);
    expect(result).toMatchObject({ answer: '本机正文', finishReason: 'stop' });
    expect(providers.resolve).toHaveBeenCalledExactlyOnceWith('owner-1', localModel);
    expect(jobs.run).toHaveBeenCalledExactlyOnceWith(connectionId, {
      provider: 'ollama', model: 'qwen/author:8b', messages: request.messages, maxTokens: 4096, temperature: 0.7,
    }, request.signal);
    expect(jobs.run.mock.calls[0][1].messages).toBe(request.messages);
    expect(jobs.run.mock.calls[0][1]).not.toHaveProperty('accountId');
    expect(jobs.run.mock.calls[0][1]).not.toHaveProperty('tools');
    expectNoCloudGeneration();
  });

  it('uses the resolved provider and preserves explicit zero temperature, maxTokens and tools', async () => {
    providers.resolve.mockResolvedValue({ connectionId, provider: 'lmstudio', model: 'local/model', tools: true });
    const request = { ...options(), maxTokens: 17, temperature: 0, tools: [tool] };
    await router.chat(request);
    expect(jobs.run).toHaveBeenCalledExactlyOnceWith(connectionId, {
      provider: 'lmstudio', model: 'local/model', messages: request.messages, maxTokens: 17, temperature: 0, tools: [tool],
    }, undefined);
    expectNoCloudGeneration();
  });

  it('omits empty tools and permits text generation on a model without tool capability', async () => {
    providers.resolve.mockResolvedValue({ connectionId, provider: 'ollama', model: 'plain', tools: false });
    await router.chat({ ...options(), tools: [] });
    expect(jobs.run.mock.calls[0][1]).not.toHaveProperty('tools');
    expectNoCloudGeneration();
  });

  it('rejects tools before enqueueing when capability is unconfirmed', async () => {
    providers.resolve.mockResolvedValue({ connectionId, provider: 'ollama', model: 'plain', tools: false });
    await expect(router.chat({ ...options(), tools: [tool] })).rejects.toThrow('此本机模型尚未确认工具调用能力');
    expect(jobs.run).not.toHaveBeenCalled();
    expectNoCloudGeneration();
  });

  it.each(['chat', 'chatStream', 'streamEvents'] as const)('never falls back when local resolution fails in %s', async (method) => {
    const error = new Error('本机连接器已离线');
    providers.resolve.mockRejectedValue(error);
    const call = method === 'chat' ? router.chat(options()) : collect<string | LlmStreamEvent>(router[method](options()));
    await expect(call).rejects.toBe(error);
    expect(jobs.run).not.toHaveBeenCalled();
    expectNoCloudGeneration();
  });

  it('revalidates each local request instead of caching a previously enabled connection', async () => {
    await router.chat(options());
    providers.resolve.mockRejectedValueOnce(new Error('本机模型连接尚未启用'));
    await expect(router.chat(options())).rejects.toThrow('本机模型连接尚未启用');
    expect(providers.resolve).toHaveBeenCalledTimes(2);
    expect(jobs.run).toHaveBeenCalledTimes(1);
    expectNoCloudGeneration();
  });

  it.each(['local/not-a-uuid/ollama/model', `local/${connectionId}/unknown/model`,
    `local/${connectionId}/ollama/%ZZ`])('rejects malformed local model %s instead of treating it as cloud', async (model) => {
    await expect(router.chat({ ...options(), model })).rejects.toThrow('本机模型标识无效');
    await expect(collect(router.chatStream({ ...options(), model }))).rejects.toThrow('本机模型标识无效');
    await expect(collect(router.streamEvents({ ...options(), model }))).rejects.toThrow('本机模型标识无效');
    expect(providers.resolve).not.toHaveBeenCalled();
    expect(jobs.run).not.toHaveBeenCalled();
    expectNoCloudGeneration();
  });

  it('rejects an unresolved local target without cloud fallback', async () => {
    providers.resolve.mockResolvedValue(null);
    await expect(router.chat(options())).rejects.toThrow('本机模型标识无效');
    expect(jobs.run).not.toHaveBeenCalled();
    expectNoCloudGeneration();
  });

  it('returns local tools, usage and terminal metadata with one measured attempt', async () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const result: LlmResult = { answer: '本机正文', finishReason: 'tool_calls', rawFinishReason: 'tool_calls',
      toolCalls: [{ id: 'call-1', name: 'read_chapter', argumentsJson: '{"id":"chapter-1"}' }],
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
      attempts: [{ status: 'completed', durationMs: 999 }],
    };
    jobs.run.mockImplementation(() => (async function* () {
      now = 125;
      yield { type: 'done', result } as LlmStreamEvent;
    })());
    expect(await router.chat({ ...options(), tools: [tool] })).toEqual({ ...result,
      attempts: [{ status: 'completed', durationMs: 25, usage: result.usage }] });
    expect(result.attempts).toEqual([{ status: 'completed', durationMs: 999 }]);
    expectNoCloudGeneration();
  });

  it('preserves text/tool deltas and adds attempts only to the terminal event', async () => {
    const delta: LlmStreamEvent = { type: 'tool_call_delta', index: 0, id: 'call-1', name: 'read_chapter', arguments: '{}' };
    const first: LlmStreamEvent = { type: 'text', text: '正文' };
    jobs.run.mockImplementation(() => events([first, delta, { type: 'done', result: { answer: '正文', finishReason: 'tool_calls',
      toolCalls: [{ id: 'call-1', name: 'read_chapter', argumentsJson: '{}' }] } }]));
    const received = await collect(router.streamEvents({ ...options(), tools: [tool] }));
    expect(received[0]).toBe(first);
    expect(received[1]).toBe(delta);
    expect(received[2]).toMatchObject({ type: 'done', result: { finishReason: 'tool_calls',
      attempts: [{ status: 'completed', durationMs: expect.any(Number), usage: undefined }] } });
    expectNoCloudGeneration();
  });

  it('yields only text from a successful local text stream', async () => {
    jobs.run.mockImplementation(() => events([{ type: 'text', text: '甲' },
      { type: 'tool_call_delta', index: 0, arguments: '' }, { type: 'text', text: '乙' },
      { type: 'done', result: { answer: '甲乙', finishReason: 'stop' } }]));
    expect(await collect(router.chatStream(options()))).toEqual(['甲', '乙']);
    expect(jobs.run).toHaveBeenCalledTimes(1);
    expectNoCloudGeneration();
  });

  it.each(['length', 'tool_calls', 'error', 'aborted', 'unknown', undefined] as const)(
    'text stream rejects terminal %s, retaining any preceding chunks', async (finishReason) => {
      jobs.run.mockImplementation(() => events([{ type: 'text', text: 'partial' },
        { type: 'done', result: { answer: 'partial', finishReason } }]));
      const stream = router.chatStream(options())[Symbol.asyncIterator]();
      expect(await stream.next()).toEqual({ done: false, value: 'partial' });
      const error = await stream.next().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmIncompleteError);
      expect((error as LlmIncompleteError).reason).toBe(finishReason ?? 'unknown');
      expectNoCloudGeneration();
    });

  it('chat rejects a broker stream that ends without a terminal result', async () => {
    jobs.run.mockImplementation(() => events([{ type: 'text', text: 'partial' }]));
    await expect(router.chat(options())).rejects.toBeInstanceOf(LlmIncompleteError);
    expect(jobs.run).toHaveBeenCalledTimes(1);
    expectNoCloudGeneration();
  });

  it.each(['length', 'error', 'aborted'] as const)('chat preserves %s so the agent can apply terminal policy', async (finishReason) => {
    jobs.run.mockImplementation(() => events([{ type: 'done', result: { answer: '', finishReason } }]));
    expect(await router.chat(options())).toMatchObject({ answer: '', finishReason });
    expectNoCloudGeneration();
  });

  it.each(['synchronous', 'streaming'] as const)('records a single failed attempt for a %s broker failure and rethrows the same error', async (mode) => {
    let now = 50;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const error = new Error('本机模型任务繁忙，请稍后重试');
    jobs.run.mockImplementation(() => {
      if (mode === 'synchronous') { now = 65; throw error; }
      return (async function* () { yield { type: 'text', text: 'partial' } as LlmStreamEvent; now = 65; throw error; })();
    });
    await expect(router.chat(options())).rejects.toBe(error);
    expect(getLlmFailureAttempts(error)).toEqual([{ status: 'failed', durationMs: 15 }]);
    expect(jobs.run).toHaveBeenCalledTimes(1);
    expectNoCloudGeneration();
  });

  it('propagates cancellation unchanged and records the failed local attempt', async () => {
    const controller = new AbortController();
    const error = new Error('用户取消');
    controller.abort(error);
    jobs.run.mockImplementation((_connection, _payload, signal: AbortSignal) => (async function* () {
      signal.throwIfAborted();
      yield { type: 'done', result: { answer: '', finishReason: 'stop' } } as LlmStreamEvent;
    })());
    await expect(router.chat({ ...options(), signal: controller.signal })).rejects.toBe(error);
    expect(getLlmFailureAttempts(error)).toEqual([{ status: 'failed', durationMs: expect.any(Number) }]);
    expect(jobs.run).toHaveBeenCalledTimes(1);
    expectNoCloudGeneration();
  });

  it('closes the broker iterator when the downstream consumer stops early', async () => {
    const closed = vi.fn();
    jobs.run.mockImplementation(() => (async function* () {
      try { yield { type: 'text', text: 'partial' } as LlmStreamEvent; }
      finally { closed(); }
    })());
    for await (const _chunk of router.chatStream(options())) break;
    expect(closed).toHaveBeenCalledTimes(1);
    expectNoCloudGeneration();
  });

  it('delegates embedding and its abort signal to the cloud independently of local generation', async () => {
    const texts = ['作品设定', '前文章节'];
    const signal = new AbortController().signal;
    const vectors = [[0.1, 0.2], [0.3, 0.4]];
    cloud.embed.mockResolvedValue(vectors);
    expect(await router.embed(texts, signal)).toBe(vectors);
    expect(cloud.embed).toHaveBeenCalledExactlyOnceWith(texts, signal);
    expect(cloud.embed.mock.calls[0][0]).toBe(texts);
    expect(providers.resolve).not.toHaveBeenCalled();
    expect(jobs.run).not.toHaveBeenCalled();
  });

  it('propagates embedding failures without local dispatch or generation retry', async () => {
    const error = new Error('embedding unavailable');
    cloud.embed.mockRejectedValue(error);
    await expect(router.embed(['正文'])).rejects.toBe(error);
    expect(cloud.embed).toHaveBeenCalledTimes(1);
    expect(jobs.run).not.toHaveBeenCalled();
    expectNoCloudGeneration();
  });
});
