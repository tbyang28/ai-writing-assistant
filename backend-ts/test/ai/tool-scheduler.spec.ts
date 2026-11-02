import { describe, expect, it, vi } from 'vitest';

import { scheduleTools } from '../../src/ai/agent/tool-scheduler';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function controlledTasks(concurrent: boolean[]) {
  const gates = concurrent.map(() => deferred());
  const started = concurrent.map(() => deferred());
  const order: string[] = [];
  let active = 0;
  let peak = 0;
  const tasks = concurrent.map((safe, index) => ({
    concurrent: safe,
    run: vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      order.push(`start-${index}`);
      started[index].resolve();
      await gates[index].promise;
      order.push(`end-${index}`);
      active--;
      return `result-${index}`;
    }),
  }));
  return { tasks, gates, started, order, peak: () => peak, active: () => active };
}

describe('工具调度器', () => {
  it('滚动池有界并行：空出一个槽位立即派发下一项，结果保留输入顺序', async () => {
    const fixture = controlledTasks([true, true, true, true, true]);
    const { tasks, gates, started, order } = fixture;
    const running = scheduleTools(tasks, 2);
    try {
      await Promise.all([started[0].promise, started[1].promise]);
      expect(order).toEqual(['start-0', 'start-1']);
      expect(tasks[2].run).not.toHaveBeenCalled();
      gates[1].resolve();
      await started[2].promise;
      expect(tasks[0].run).toHaveBeenCalledTimes(1);
      expect(order).not.toContain('end-0');
      expect(tasks[3].run).not.toHaveBeenCalled();
      gates[2].resolve();
      await started[3].promise;
      gates[3].resolve();
      await started[4].promise;
      gates[4].resolve();
      gates[0].resolve();
      expect(await running).toEqual(['result-0', 'result-1', 'result-2', 'result-3', 'result-4']);
      expect(fixture.peak()).toBe(2);
      expect(fixture.active()).toBe(0);
      expect(order.filter((event) => event.startsWith('end-')))
        .toEqual(['end-1', 'end-2', 'end-3', 'end-4', 'end-0']);
    } finally { gates.forEach((gate) => gate.resolve()); }
  });

  it.each([
    { concurrency: 0, expected: 1 },
    { concurrency: -2, expected: 1 },
    { concurrency: Number.NaN, expected: 1 },
    { concurrency: 2.9, expected: 2 },
    { concurrency: 99, expected: 3 },
  ])('并行度 $concurrency 归一到 $expected 个槽位', async ({ concurrency, expected }) => {
    const { tasks, gates } = controlledTasks([true, true, true, true]);
    const running = scheduleTools(tasks, concurrency);
    try {
      expect(tasks.map((task) => task.run.mock.calls.length))
        .toEqual(tasks.map((_, index) => index < expected ? 1 : 0));
    } finally { gates.forEach((gate) => gate.resolve()); }
    expect(await running).toEqual(['result-0', 'result-1', 'result-2', 'result-3']);
  });

  it('串行工具是前后屏障：等待全部在途读取，独占执行后再放行后续读取', async () => {
    const fixture = controlledTasks([true, true, false, true, true]);
    const { tasks, gates, started, order } = fixture;
    const running = scheduleTools(tasks, 3);
    try {
      await Promise.all([started[0].promise, started[1].promise]);
      gates[1].resolve();
      await Promise.resolve();
      expect(tasks[2].run).not.toHaveBeenCalled();
      expect(tasks[3].run).not.toHaveBeenCalled();
      gates[0].resolve();
      await started[2].promise;
      expect(fixture.active()).toBe(1);
      expect(order).toEqual(['start-0', 'start-1', 'end-1', 'end-0', 'start-2']);
      expect(tasks[3].run).not.toHaveBeenCalled();
      expect(tasks[4].run).not.toHaveBeenCalled();
      gates[2].resolve();
      await Promise.all([started[3].promise, started[4].promise]);
      expect(order.indexOf('end-2')).toBeLessThan(order.indexOf('start-3'));
      expect(fixture.active()).toBe(2);
    } finally { gates.forEach((gate) => gate.resolve()); }
    expect(await running).toEqual(['result-0', 'result-1', 'result-2', 'result-3', 'result-4']);
  });

  it('取消后不派发排队任务，并等所有已启动任务结束后才拒绝', async () => {
    const controller = new AbortController();
    const reason = new Error('用户取消');
    const { tasks, gates, started } = controlledTasks([true, true, true, false, true]);
    let settled = false;
    const outcome = scheduleTools(tasks, 2, controller.signal).then(
      (value) => { settled = true; return { value, error: undefined }; },
      (error: unknown) => { settled = true; return { value: undefined, error }; },
    );
    try {
      await Promise.all([started[0].promise, started[1].promise]);
      controller.abort(reason);
      gates[0].resolve();
      // 让已完成 worker 有机会观察取消；另一个已启动任务仍被门闩挂起。
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(tasks.slice(2).every((task) => task.run.mock.calls.length === 0)).toBe(true);
      gates[1].resolve();
      expect(await outcome).toEqual({ value: undefined, error: reason });
      expect(tasks.map((task) => task.run.mock.calls.length)).toEqual([1, 1, 0, 0, 0]);
    } finally { gates.forEach((gate) => gate.resolve()); }
  });

  it('串行屏障执行期间取消，不会越过屏障派发后续任务', async () => {
    const controller = new AbortController();
    const reason = new Error('屏障处取消');
    const { tasks, gates, started } = controlledTasks([false, true, true]);
    const outcome = scheduleTools(tasks, 3, controller.signal).catch((error: unknown) => error);
    await started[0].promise;
    controller.abort(reason);
    gates.forEach((gate) => gate.resolve());
    expect(await outcome).toBe(reason);
    expect(tasks.map((task) => task.run.mock.calls.length)).toEqual([1, 0, 0]);
  });

  it('预先取消时一个任务都不启动', async () => {
    const controller = new AbortController();
    const reason = new Error('已取消');
    controller.abort(reason);
    const run = vi.fn(async () => '不应执行');
    await expect(scheduleTools([{ concurrent: true, run }, { concurrent: false, run }], 2, controller.signal))
      .rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
  });

  it('任务失败后等待已启动的兄弟任务结束，再传播原错误且不越过串行屏障', async () => {
    const sibling = deferred();
    const siblingStarted = deferred();
    const error = new Error('读取失败');
    const barrier = vi.fn(async () => '不应执行');
    let settled = false;
    const outcome = scheduleTools([
      { concurrent: true, run: async () => { throw error; } },
      { concurrent: true, run: async () => { siblingStarted.resolve(); await sibling.promise; return '读取完成'; } },
      { concurrent: false, run: barrier },
    ], 2).catch((caught: unknown) => { settled = true; return caught; });
    await siblingStarted.promise;
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(barrier).not.toHaveBeenCalled();
    } finally { sibling.resolve(); }
    expect(await outcome).toBe(error);
    expect(barrier).not.toHaveBeenCalled();
  });

  it('空任务列表返回空结果', async () => {
    expect(await scheduleTools([], 2)).toEqual([]);
  });
});
