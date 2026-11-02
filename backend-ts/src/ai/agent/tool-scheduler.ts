/** 有限滚动池：只并发连续的安全读取；其它调用作为前后屏障。 */
export async function scheduleTools<T>(
  tasks: Array<{ concurrent: boolean; run: () => Promise<T> }>,
  concurrency: number,
  signal?: AbortSignal,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const limit = Math.max(1, Math.min(3, Math.floor(concurrency) || 1));
  let offset = 0;
  while (offset < tasks.length) {
    signal?.throwIfAborted();
    if (!tasks[offset].concurrent) {
      results[offset] = await tasks[offset].run();
      offset++;
      continue;
    }
    let end = offset;
    while (end < tasks.length && tasks[end].concurrent) end++;
    let next = offset;
    // 所有已开始任务 settle 后再抛出，避免运行已经结束却仍有悬空副作用。
    const workers = Array.from({ length: Math.min(limit, end - offset) }, async () => {
      while (next < end) {
        signal?.throwIfAborted();
        const index = next++;
        results[index] = await tasks[index].run();
      }
    });
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected) throw rejected.reason;
    offset = end;
  }
  signal?.throwIfAborted();
  return results;
}
