import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmIncompleteError, type LlmStreamEvent } from '../../src/ai/llm/llm-client.interface';
import { LocalJobBroker, type LocalJob } from '../../src/local-providers/local-job-broker';
import type { RuntimeEvent } from '../../src/local-providers/protocol';

const payload = (): Omit<LocalJob, 'id'> => ({
  provider: 'ollama', model: 'qwen:8b', messages: [{ role: 'user', content: '续写作品' }],
  maxTokens: 4096, temperature: 0.7,
});
const text = (value: string): RuntimeEvent => ({ type: 'text', text: value });
const done = (answer = ''): RuntimeEvent => ({ type: 'done', result: { answer, finishReason: 'stop' } });

function httpError(action: () => void, status: number) {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    return;
  }
  throw new Error(`Expected HTTP ${status}`);
}

// Inspect retained references only for the contract's memory erasure requirement.
function memory(broker: LocalJobBroker) {
  return broker as unknown as {
    jobs: Map<string, { payload: LocalJob | null; text: string; events: RuntimeEvent[]; notify?: () => void }>;
    tombstones: Map<string, { connectionId: string; status: string; seq: number; hash: string; expiresAt: number }>;
  };
}

describe('LocalJobBroker', () => {
  let broker: LocalJobBroker;
  let controllers: AbortController[];
  let pending: Promise<unknown>[];
  let streams: AsyncIterator<LlmStreamEvent>[];

  function start(connectionId = 'connection-a', body = payload()) {
    const controller = new AbortController();
    controllers.push(controller);
    const stream = broker.run(connectionId, body, controller.signal)[Symbol.asyncIterator]();
    streams.push(stream);
    // Attach rejection handling before cancellation/timeout, including failed assertions.
    const first = stream.next().then((value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }));
    pending.push(first);
    return { stream, first, controller };
  }
  function dispatch(connectionId = 'connection-a') {
    const job = broker.take(connectionId);
    expect(job).not.toBeNull();
    return job!;
  }
  async function finish(handle: ReturnType<typeof start>, job: LocalJob, connectionId = 'connection-a') {
    broker.accept(connectionId, job.id, 1, done());
    expect((await handle.first).value).toEqual({ done: false, value: done() });
    expect(await handle.stream.next()).toEqual({ done: true, value: undefined });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new LocalJobBroker();
    controllers = [];
    pending = [];
    streams = [];
  });
  afterEach(async () => {
    controllers.forEach((controller) => controller.abort());
    broker.onModuleDestroy();
    await Promise.all(pending);
    await Promise.all(streams.map((stream) => stream.return?.()));
    vi.useRealTimers();
  });

  it('dispatches each job once in FIFO order with its exact payload', async () => {
    const body = { ...payload(), tools: [{ name: 'read', description: '读取', parameters: { type: 'object' } }] };
    const first = start('connection-a', body);
    const second = start();
    const job1 = dispatch();
    const job2 = dispatch();
    expect(job1).toEqual({ ...body, id: expect.any(String) });
    expect(job2.id).not.toBe(job1.id);
    expect(broker.take('connection-a')).toBeNull();
    expect(broker.status('connection-a', job1.id)).toEqual({ status: 'running' });
    await finish(first, job1);
    await finish(second, job2);
  });

  it('counts both queued and running jobs toward the per-connection limit and releases capacity', async () => {
    const first = start();
    const job1 = dispatch();
    start(); // queued, while the first job is running
    const rejected = start();
    expect((await rejected.first).error).toEqual(new Error('本机模型任务繁忙，请稍后重试'));
    expect(broker.take('connection-b')).toBeNull();
    await finish(first, job1);
    const replacement = start();
    dispatch(); // second, previously queued job
    const job3 = dispatch();
    expect(job3.id).not.toBe(job1.id);
    await finish(replacement, job3);
  });

  it('allows exactly 32 global jobs and reuses a slot after completion', async () => {
    const handles = Array.from({ length: 32 }, (_, index) => start(`connection-${index}`));
    const rejected = start('overflow');
    expect((await rejected.first).error).toEqual(new Error('本机模型任务繁忙，请稍后重试'));
    expect(broker.take('overflow')).toBeNull();
    await finish(handles[0], dispatch('connection-0'), 'connection-0');
    const replacement = start('overflow');
    await finish(replacement, dispatch('overflow'), 'overflow');
  });

  it('isolates dispatch, status, events and tombstones by connection', async () => {
    const first = start();
    const other = start('connection-b');
    expect(broker.take('unrelated')).toBeNull();
    const job = dispatch();
    const otherJob = dispatch('connection-b');
    httpError(() => broker.status('connection-b', job.id), 404);
    httpError(() => broker.accept('connection-b', job.id, 1, done()), 404);
    await finish(first, job);
    httpError(() => broker.status('connection-b', job.id), 404);
    httpError(() => broker.accept('connection-b', job.id, 1, done()), 404);
    await finish(other, otherJob, 'connection-b');
  });

  it('rejects events before dispatch and unknown task IDs without consuming a sequence number', async () => {
    const handle = start();
    const id = [...memory(broker).jobs.keys()][0];
    expect(broker.status('connection-a', id)).toEqual({ status: 'running' });
    httpError(() => broker.accept('connection-a', id, 1, done()), 409);
    httpError(() => broker.accept('connection-a', 'missing', 1, done()), 404);
    httpError(() => broker.status('connection-a', 'missing'), 404);
    await finish(handle, dispatch());
  });

  it('deduplicates only identical last-event retries; rejects skipped, stale and rewritten events', async () => {
    const handle = start();
    const job = dispatch();
    httpError(() => broker.accept('connection-a', job.id, 2, text('wrong')), 409);
    broker.accept('connection-a', job.id, 1, text('甲'));
    broker.accept('connection-a', job.id, 1, text('甲'));
    httpError(() => broker.accept('connection-a', job.id, 1, text('改写')), 409);
    expect((await handle.first).value?.value).toEqual(text('甲'));
    broker.accept('connection-a', job.id, 2, text('乙'));
    httpError(() => broker.accept('connection-a', job.id, 1, text('甲')), 409);
    expect(await handle.stream.next()).toEqual({ done: false, value: text('乙') });
    broker.accept('connection-a', job.id, 3, done('甲乙'));
    broker.accept('connection-a', job.id, 3, done('甲乙'));
    expect((await handle.stream.next()).value).toEqual(done('甲乙'));
    await handle.stream.next();
    expect(() => broker.accept('connection-a', job.id, 3, done('甲乙'))).not.toThrow();
    httpError(() => broker.accept('connection-a', job.id, 3, done('篡改')), 409);
    httpError(() => broker.accept('connection-a', job.id, 4, text('late')), 409);
    httpError(() => broker.accept('connection-a', job.id, 2, text('乙')), 409);
  });

  it('accepts 64 buffered events; a rejected 65th event can retry after a consumer drains one', async () => {
    const handle = start();
    const job = dispatch();
    broker.accept('connection-a', job.id, 1, text('起'));
    await handle.first; // consumer is now suspended at yield
    for (let seq = 2; seq <= 65; seq++) broker.accept('connection-a', job.id, seq, text('字'));
    // Identical replay must not occupy a slot or be rejected by backpressure.
    expect(() => broker.accept('connection-a', job.id, 65, text('字'))).not.toThrow();
    httpError(() => broker.accept('connection-a', job.id, 66, text('尾')), 429);
    expect((await handle.stream.next()).value).toEqual(text('字'));
    broker.accept('connection-a', job.id, 66, text('尾'));
    for (let index = 0; index < 63; index++) expect((await handle.stream.next()).value).toEqual(text('字'));
    expect((await handle.stream.next()).value).toEqual(text('尾'));
    broker.accept('connection-a', job.id, 67, done(`起${'字'.repeat(64)}尾`));
    expect((await handle.stream.next()).value).toEqual(done(`起${'字'.repeat(64)}尾`));
    await handle.stream.next();
  });

  it.each([0, 1])('measures the 200000-byte input boundary including UTF-8 and JSON overhead (+%i)', async (excess) => {
    const body = payload();
    body.messages[0].content = '';
    const overhead = Buffer.byteLength(JSON.stringify(body));
    const available = 200000 - overhead;
    body.messages[0].content = '中'.repeat(Math.floor(available / 3)) + 'a'.repeat(available % 3 + excess);
    expect(Buffer.byteLength(JSON.stringify(body))).toBe(200000 + excess);
    const handle = start('connection-a', body);
    if (excess) {
      expect((await handle.first).error).toEqual(new Error('本机模型任务过大，请缩小范围'));
      expect(broker.take('connection-a')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } else await finish(handle, dispatch());
  });

  it('accepts exactly 200000 text characters and a matching terminal answer', async () => {
    const handle = start();
    const job = dispatch();
    // ASCII keeps the echoed terminal answer below the independent 1 MB event budget.
    const chunks = Array.from({ length: 20 }, () => 'a'.repeat(10000));
    broker.accept('connection-a', job.id, 1, text(chunks[0]));
    await handle.first;
    for (let index = 1; index < chunks.length; index++) {
      broker.accept('connection-a', job.id, index + 1, text(chunks[index]));
      await handle.stream.next();
    }
    const terminal = done(chunks.join(''));
    broker.accept('connection-a', job.id, 21, terminal);
    expect((await handle.stream.next()).value).toEqual(terminal);
    await handle.stream.next();
  });

  it('cancels after the text limit and erases buffered output', async () => {
    const handle = start();
    const job = dispatch();
    for (let seq = 1; seq <= 20; seq++) broker.accept('connection-a', job.id, seq, text('a'.repeat(10000)));
    httpError(() => broker.accept('connection-a', job.id, 21, text('x')), 413);
    expect((await handle.first).error).toEqual(new Error('本机模型结果超过限额'));
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'cancelled' });
    expect(memory(broker).jobs.size).toBe(0);
  });

  it('limits aggregate event bytes even when tool arguments do not add text', async () => {
    const handle = start();
    const job = dispatch();
    const prefix = { type: 'tool_call_delta' as const, index: 0, arguments: '' };
    const overhead = Buffer.byteLength(JSON.stringify(prefix));
    // Each event is schema-valid and exactly 10000 bytes; consume so backpressure cannot mask the byte limit.
    const event = { ...prefix, arguments: '中'.repeat(Math.floor((10000 - overhead) / 3)) + 'a'.repeat((10000 - overhead) % 3) };
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(10000);
    broker.accept('connection-a', job.id, 1, event);
    await handle.first;
    for (let seq = 2; seq <= 100; seq++) {
      broker.accept('connection-a', job.id, seq, event);
      await handle.stream.next();
    }
    httpError(() => broker.accept('connection-a', job.id, 101, event), 413);
    await expect(handle.stream.next()).rejects.toThrow('本机模型结果超过限额');
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'cancelled' });
  });

  it.each(['wrong answer', ''])('rejects terminal text inconsistent with streamed content (%j)', async (answer) => {
    const handle = start();
    const job = dispatch();
    broker.accept('connection-a', job.id, 1, text('正文'));
    await handle.first;
    httpError(() => broker.accept('connection-a', job.id, 2, done(answer)), 409);
    await expect(handle.stream.next()).rejects.toThrow('本机模型结果不完整');
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'cancelled' });
  });

  it.each(['unknown', 'stop', 'error', 'aborted'] as const)('rejects unknown terminals or tool calls paired with %s', async (finishReason) => {
    const handle = start();
    const job = dispatch();
    broker.accept('connection-a', job.id, 1, { type: 'done', result: {
      answer: '', finishReason, ...(finishReason === 'unknown' ? {} : {
        toolCalls: [{ id: 'call-1', name: 'read', argumentsJson: '{}' }],
      }),
    } });
    const { error } = await handle.first;
    expect(error).toBeInstanceOf(LlmIncompleteError);
    expect((error as LlmIncompleteError).reason).toBe('error');
    expect(memory(broker).jobs.size).toBe(0);
  });

  it('invalid unknown terminal must not leave a successful, replayable tombstone', async () => {
    const handle = start();
    const job = dispatch();
    const terminal: RuntimeEvent = { type: 'done', result: { answer: '', finishReason: 'unknown' } };
    broker.accept('connection-a', job.id, 1, terminal);
    expect((await handle.first).error).toBeInstanceOf(LlmIncompleteError);
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'cancelled' });
    httpError(() => broker.accept('connection-a', job.id, 1, terminal), 409);
  });

  it.each(['stop', 'tool_calls', 'length', 'error', 'aborted'] as const)('preserves explicit %s terminal metadata for the caller', async (finishReason) => {
    const handle = start();
    const job = dispatch();
    const event: RuntimeEvent = { type: 'done', result: { answer: '', finishReason,
      rawFinishReason: finishReason, usage: { inputTokens: 4, outputTokens: 2 },
      ...(['tool_calls', 'length'].includes(finishReason) ? { toolCalls: [{ id: 'call-1', name: 'read', argumentsJson: '{}' }] } : {}),
    } };
    broker.accept('connection-a', job.id, 1, event);
    expect((await handle.first).value?.value).toEqual(event);
    await handle.stream.next();
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'completed' });
  });

  it('sanitizes connector failures and rejects late events', async () => {
    const handle = start();
    const job = dispatch();
    const event: RuntimeEvent = { type: 'failure', message: 'private model output / secret' };
    broker.accept('connection-a', job.id, 1, event);
    expect((await handle.first).error).toEqual(new Error('本机模型调用失败，请在本机检查模型服务'));
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'cancelled' });
    httpError(() => broker.accept('connection-a', job.id, 1, event), 409);
  });

  it('never queues an already aborted request', async () => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    const stream = broker.run('connection-a', payload(), controller.signal)[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toBe(reason);
    expect(broker.take('connection-a')).toBeNull();
    expect(memory(broker).tombstones.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['queued', 'running'] as const)('cleans a %s request on cancellation, including listeners and payload references', async (phase) => {
    const handle = start();
    const id = [...memory(broker).jobs.keys()][0];
    const retained = memory(broker).jobs.get(id)!;
    if (phase === 'running') dispatch();
    const removeListener = vi.spyOn(handle.controller.signal, 'removeEventListener');
    handle.controller.abort();
    expect((await handle.first).error).toEqual(new Error('本机模型任务已取消'));
    expect(retained).toMatchObject({ payload: null, text: '', events: [], notify: undefined });
    expect(memory(broker).jobs.size).toBe(0);
    expect(broker.take('connection-a')).toBeNull();
    expect(broker.status('connection-a', id)).toEqual({ status: 'cancelled' });
    httpError(() => broker.accept('connection-a', id, 1, done()), 409);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['queued', 'running'] as const)('times out a %s task at exactly 120 seconds and releases its slot', async (phase) => {
    const handle = start();
    const id = [...memory(broker).jobs.keys()][0];
    if (phase === 'running') dispatch();
    await vi.advanceTimersByTimeAsync(119999);
    expect(broker.status('connection-a', id)).toEqual({ status: 'running' });
    await vi.advanceTimersByTimeAsync(1);
    expect((await handle.first).error).toEqual(new Error('本机连接器未及时响应，请检查电脑连接后重试'));
    expect(broker.status('connection-a', id)).toEqual({ status: 'cancelled' });
    expect(memory(broker).jobs.size).toBe(0);
    await finish(start(), dispatch());
  });

  it('requires a terminal event even after streaming text', async () => {
    const handle = start();
    const job = dispatch();
    broker.accept('connection-a', job.id, 1, text('partial'));
    await handle.first;
    const outcome = handle.stream.next().catch((error: unknown) => error);
    pending.push(outcome);
    await vi.advanceTimersByTimeAsync(120000);
    expect(await outcome).toEqual(new Error('本机连接器未及时响应，请检查电脑连接后重试'));
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'cancelled' });
  });

  it('disabling/revoking a connection cancels its queued and active tasks without affecting another connection', async () => {
    const running = start();
    const activeJob = dispatch();
    const queued = start();
    const other = start('connection-b');
    broker.cancelConnection('connection-a');
    expect((await running.first).error).toEqual(new Error('本机连接已停用或撤销'));
    expect((await queued.first).error).toEqual(new Error('本机连接已停用或撤销'));
    expect(broker.take('connection-a')).toBeNull();
    expect(broker.status('connection-a', activeJob.id)).toEqual({ status: 'cancelled' });
    await finish(other, dispatch('connection-b'), 'connection-b');
  });

  it('shutdown wakes all waiters and removes every queued/running job and timer', async () => {
    const first = start();
    const job = dispatch();
    const queued = start('connection-b');
    broker.onModuleDestroy();
    for (const handle of [first, queued]) {
      expect((await handle.first).error).toEqual(new Error('模型服务已重启，请重新发起任务'));
    }
    expect(memory(broker).jobs.size).toBe(0);
    expect(broker.take('connection-b')).toBeNull();
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consumer return clears buffered text, input, timer and cancellation listener', async () => {
    const handle = start();
    const job = dispatch();
    const retained = memory(broker).jobs.get(job.id)!;
    broker.accept('connection-a', job.id, 1, text('private text'));
    await handle.first;
    broker.accept('connection-a', job.id, 2, text('buffered text'));
    const removeListener = vi.spyOn(handle.controller.signal, 'removeEventListener');
    await handle.stream.return!();
    expect(retained).toMatchObject({ payload: null, text: '', events: [], notify: undefined });
    expect(memory(broker).jobs.size).toBe(0);
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'cancelled' });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains only a bounded metadata tombstone, expiring exactly 60 seconds after consumption', async () => {
    const handle = start();
    const job = dispatch();
    const retained = memory(broker).jobs.get(job.id)!;
    await finish(handle, job);
    expect(retained).toMatchObject({ payload: null, text: '', events: [], notify: undefined });
    expect(memory(broker).jobs.size).toBe(0);
    expect(memory(broker).tombstones.get(job.id)).toEqual({ connectionId: 'connection-a', status: 'completed',
      seq: 1, hash: expect.stringMatching(/^[a-f0-9]{64}$/), expiresAt: Date.now() + 60000 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(59999);
    expect(broker.status('connection-a', job.id)).toEqual({ status: 'completed' });
    await vi.advanceTimersByTimeAsync(1);
    httpError(() => broker.status('connection-a', job.id), 404);
    httpError(() => broker.accept('connection-a', job.id, 1, done()), 404);
  });

  it('bounds completed tombstones even when many tasks finish before their TTL', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 130; index++) {
      const handle = start();
      const job = dispatch();
      ids.push(job.id);
      await finish(handle, job);
    }
    expect(memory(broker).tombstones.size).toBeLessThanOrEqual(128);
    httpError(() => broker.status('connection-a', ids[0]), 404);
    expect(broker.status('connection-a', ids.at(-1)!)).toEqual({ status: 'completed' });
  });
});
