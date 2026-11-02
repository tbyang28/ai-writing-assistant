import { ConflictException, HttpException, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { LlmCallOptions, LlmStreamEvent } from '../ai/llm/llm-client.interface';
import { LlmIncompleteError } from '../ai/llm/llm-client.interface';
import type { RuntimeEvent } from './protocol';

export interface LocalJob {
  id: string;
  provider: 'ollama' | 'lmstudio';
  model: string;
  messages: LlmCallOptions['messages'];
  tools?: LlmCallOptions['tools'];
  maxTokens: number;
  temperature: number;
}
interface Pending {
  connectionId: string; payload: LocalJob | null; state: 'queued' | 'running' | 'completed' | 'cancelled';
  events: RuntimeEvent[]; error?: Error; notify?: () => void; seq: number; hash: string;
  bytes: number; text: string;
}

/** v1 单实例、有限内存队列。正文不入库、不自动重试生成；终态清理正文，仅保留短期幂等墓碑。 */
@Injectable()
export class LocalJobBroker implements OnModuleDestroy {
  private readonly jobs = new Map<string, Pending>();
  private readonly tombstones = new Map<string, { connectionId: string; status: 'cancelled' | 'completed'; seq: number; hash: string; expiresAt: number }>();
  readonly timeoutMs = 120000;

  async *run(connectionId: string, payload: Omit<LocalJob, 'id'>, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    signal?.throwIfAborted();
    if (this.jobs.size >= 32 || [...this.jobs.values()].filter((j) => j.connectionId === connectionId).length >= 2) {
      throw new Error('本机模型任务繁忙，请稍后重试');
    }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 200000) throw new Error('本机模型任务过大，请缩小范围');
    const id = randomUUID();
    const job: Pending = { connectionId, payload: { ...payload, id }, state: 'queued', events: [], seq: 0, hash: '', bytes: 0, text: '' };
    this.jobs.set(id, job);
    const abort = () => this.fail(job, new Error('本机模型任务已取消'));
    const timer = setTimeout(() => this.fail(job, new Error('本机连接器未及时响应，请检查电脑连接后重试')), this.timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      while (true) {
        if (job.error) throw job.error;
        const event = job.events.shift();
        if (!event) { await new Promise<void>((resolve) => { job.notify = resolve; }); continue; }
        if (event.type === 'failure') throw new Error('本机模型调用失败，请在本机检查模型服务');
        if (event.type === 'done' && (event.result.finishReason === 'unknown' ||
          (event.result.toolCalls?.length && !['tool_calls', 'length'].includes(event.result.finishReason)))) {
          job.state = 'cancelled';
          throw new LlmIncompleteError('error');
        }
        yield event;
        if (event.type === 'done') return;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.jobs.delete(id);
      this.prune();
      this.tombstones.set(id, { connectionId, status: job.state === 'completed' ? 'completed' : 'cancelled',
        seq: job.seq, hash: job.hash, expiresAt: Date.now() + 60000 });
      job.payload = null; job.text = ''; job.events.length = 0; job.notify = undefined;
    }
  }

  take(connectionId: string): LocalJob | null {
    for (const job of this.jobs.values()) {
      if (job.connectionId === connectionId && job.state === 'queued') {
        job.state = 'running';
        const payload = job.payload!;
        job.payload = null; // 转交后不重复派发。
        return payload;
      }
    }
    return null;
  }

  accept(connectionId: string, id: string, seq: number, event: RuntimeEvent): void {
    this.prune();
    const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const job = this.jobs.get(id);
    if (!job) {
      const tombstone = this.tombstones.get(id);
      if (!tombstone || tombstone.connectionId !== connectionId) throw new NotFoundException('任务不存在');
      if (tombstone.status === 'completed' && seq === tombstone.seq && hash === tombstone.hash) return;
      throw new ConflictException('任务已结束');
    }
    if (job.connectionId !== connectionId) throw new NotFoundException('任务不存在');
    if (seq === job.seq && hash === job.hash && job.state !== 'cancelled') return;
    if (job.state !== 'running' || seq !== job.seq + 1) throw new ConflictException('任务已结束或事件顺序错误');
    if (job.events.length >= 64) throw new HttpException('结果队列繁忙', 429);
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (job.bytes + size > 1000000) { this.fail(job, new Error('本机模型结果超过限额')); throw new HttpException('结果过大', 413); }
    if (event.type === 'text') {
      if (job.text.length + event.text.length > 200000) { this.fail(job, new Error('本机模型结果超过限额')); throw new HttpException('结果过大', 413); }
      job.text += event.text;
    }
    if (event.type === 'done' && event.result.answer !== job.text) {
      this.fail(job, new Error('本机模型结果不完整')); throw new ConflictException('模型结果不一致');
    }
    job.seq = seq; job.hash = hash; job.bytes += size;
    job.events.push(event);
    if (event.type === 'done') job.state = 'completed';
    if (event.type === 'failure') job.state = 'cancelled';
    job.notify?.(); job.notify = undefined;
  }

  status(connectionId: string, id: string) {
    this.prune();
    const job = this.jobs.get(id);
    if (job?.connectionId === connectionId) return { status: job.state === 'queued' ? 'running' : job.state };
    const old = this.tombstones.get(id);
    if (old?.connectionId === connectionId) return { status: old.status };
    throw new NotFoundException('任务不存在');
  }
  cancelConnection(connectionId: string): void {
    for (const job of this.jobs.values()) if (job.connectionId === connectionId) this.fail(job, new Error('本机连接已停用或撤销'));
  }
  onModuleDestroy(): void { for (const job of this.jobs.values()) this.fail(job, new Error('模型服务已重启，请重新发起任务')); }
  private fail(job: Pending, error: Error) {
    job.state = 'cancelled'; job.error = error; job.payload = null;
    job.events.length = 0; job.text = ''; job.notify?.(); job.notify = undefined;
  }
  private prune() {
    for (const [id, old] of this.tombstones) if (old.expiresAt <= Date.now()) this.tombstones.delete(id);
    while (this.tombstones.size >= 128) this.tombstones.delete(this.tombstones.keys().next().value!);
  }
}
