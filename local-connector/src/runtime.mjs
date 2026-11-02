import { ConnectorError, HttpTransport, delay, linkedController } from './http.mjs';
import { generate, validJobId } from './generation.mjs';

export function validateApiRoot(value) {
  try {
    if (typeof value !== 'string' || /[\s\\?#]/.test(value)) throw new Error();
    const url = new URL(value);
    const rawPath = value.match(/^https?:\/\/[^/]+(\/.*)$/)?.[1];
    if (url.username || url.password || !/^\/(?:[a-zA-Z0-9_-]+\/)*api$/.test(rawPath ?? '')) throw new Error();
    const authority = value.match(/^https?:\/\/([^/]+)\//)?.[1];
    if (authority?.includes('@')) throw new Error();
    const explicitLoopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority ?? '');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && explicitLoopback)) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new ConnectorError('invalid_api_root'); }
}

export class CloudRuntime {
  constructor({ apiRoot, transport = new HttpTransport(), timeoutMs = 8000 }) {
    this.apiRoot = validateApiRoot(apiRoot);
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.token = undefined;
  }

  async request(path, { body, signal, method = 'POST', authenticated = true } = {}) {
    if (authenticated && !this.token) throw new ConnectorError('not_paired');
    return this.transport.json(`${this.apiRoot}/local-runtime${path}`, {
      method, body, signal, timeoutMs: this.timeoutMs, maxBytes: 2_097_152,
      headers: authenticated ? { Authorization: `Bearer ${this.token}` } : {},
    });
  }

  async pair({ code, name = '我的电脑', inventory }, signal) {
    if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) throw new ConnectorError('invalid_pair_code');
    if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new ConnectorError('invalid_name');
    const result = await this.request('/pair', { body: { version: 1, code, name, inventory }, signal, authenticated: false });
    if (!validJobId(result?.connectionId) || typeof result?.token !== 'string'
      || !new RegExp(`^${result.connectionId}\\.[a-f\\d]{64}$`, 'i').test(result.token)) throw new ConnectorError('invalid_pair_response');
    this.token = result.token;
    return result.connectionId;
  }

  async poll(inventory, signal) {
    const result = await this.request('/poll', { body: { inventory }, signal });
    if (!result || !Object.hasOwn(result, 'job') || (result.job !== null && typeof result.job !== 'object')) throw new ConnectorError('invalid_response');
    return result.job;
  }

  async status(id, signal) {
    if (!validJobId(id)) throw new ConnectorError('invalid_job');
    const result = await this.request(`/jobs/${id}/status`, { method: 'GET', signal });
    if (!['running', 'cancelled', 'completed'].includes(result?.status)) throw new ConnectorError('invalid_response');
    return result.status;
  }

  async event(id, seq, event, signal) {
    if (!validJobId(id)) throw new ConnectorError('invalid_job');
    const body = { seq, event };
    // Only an ambiguous network failure is replayed; generation is never retried.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.request(`/jobs/${id}/events`, { body, signal });
        if (result?.accepted !== true) throw new ConnectorError('invalid_ack');
        return;
      } catch (error) {
        if (signal?.aborted || attempt === 1 || !['network', 'timeout'].includes(error.code)) throw new ConnectorError('event_delivery');
      }
    }
  }

  clear() { this.token = undefined; }
}

const FAILURE = Object.freeze({
  invalid_job: '本地任务未通过安全或能力校验',
  timeout: '本地模型响应超时',
  body_limit: '本地模型响应超过限制',
  incomplete_stream: '本地模型未返回有效终态',
});

export class ConnectorRuntime {
  constructor({ cloud, providers, pollMs = 2000, inventoryMs = 15_000, statusMs = 1000, jobTimeoutMs = 120_000, log = () => {} }) {
    this.cloud = cloud;
    this.providers = providers;
    this.pollMs = pollMs;
    this.inventoryMs = inventoryMs;
    this.statusMs = statusMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.log = log;
    this.active = new Map();
    this.seen = new Set();
  }

  async run({ code, name, signal }) {
    const lifetime = new AbortController();
    const abort = () => lifetime.abort(new ConnectorError('cancelled'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const sessionSignal = lifetime.signal;
    let loops = [];
    try {
      sessionSignal.throwIfAborted();
      await this.providers.discover(sessionSignal);
      await this.cloud.pair({ code, name, inventory: this.providers.inventory }, sessionSignal);
      code = undefined;
      this.log('连接器已配对；请在网页中启用本机连接。');
      loops = [this.pollLoop(sessionSignal), this.inventoryLoop(sessionSignal)];
      await Promise.all(loops);
    } catch (error) {
      if (!sessionSignal.aborted) throw error;
    } finally {
      abort();
      await Promise.allSettled(loops);
      await Promise.allSettled([...this.active.values()]);
      this.active.clear();
      this.seen.clear();
      this.cloud.clear();
      signal?.removeEventListener('abort', abort);
    }
  }

  async inventoryLoop(signal) {
    let refreshedAt = performance.now();
    for (;;) {
      // Refresh ahead of the 20s contract limit, leaving room for bounded discovery.
      await delay(Math.max(0, this.inventoryMs - (performance.now() - refreshedAt)), signal);
      refreshedAt = performance.now();
      await this.providers.discover(signal);
    }
  }

  async pollLoop(signal) {
    for (;;) {
      signal.throwIfAborted();
      try {
        const job = await this.cloud.poll(this.providers.inventory, signal);
        if (job !== null) {
          if (!validJobId(job?.id)) throw new ConnectorError('invalid_job');
          if (!this.seen.has(job.id)) {
            // Never evict replay protection while a session is alive. Re-pair when full.
            if (this.seen.size >= 4096) throw new ConnectorError('session_limit');
            if (this.active.size >= 2) throw new ConnectorError('concurrency_limit');
            this.seen.add(job.id);
            const task = this.runJob(job, signal).catch(() => {
              this.log('本地任务已停止。');
            }).finally(() => this.active.delete(job.id));
            this.active.set(job.id, task);
          }
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (!['network', 'timeout'].includes(error.code)) throw error;
        // No task or text is replayed; the next request is a new heartbeat/poll.
        this.log('连接暂时中断，正在等待恢复。');
      }
      await delay(this.pollMs, signal);
    }
  }

  async runJob(job, sessionSignal) {
    const scope = linkedController(sessionSignal, this.jobTimeoutMs);
    const signal = scope.controller.signal;
    const statusStop = new AbortController();
    let remoteStopped = false, deliveryFailed = false, seq = 0, eventBytes = 0;
    const send = async (event) => {
      if (signal.aborted) throw signal.reason;
      const size = Buffer.byteLength(JSON.stringify(event));
      // Reserve room for a fixed failure event within the server's 1MB/10000-event budget.
      if (eventBytes + size > 999_000 || seq >= 9999) throw new ConnectorError('body_limit');
      try { await this.cloud.event(job.id, seq + 1, event, signal); seq++; eventBytes += size; }
      catch { deliveryFailed = true; throw new ConnectorError('event_delivery'); }
    };
    const monitor = (async () => {
      let checkedAt = performance.now();
      while (!signal.aborted) {
        await delay(Math.max(0, this.statusMs - (performance.now() - checkedAt)), statusStop.signal);
        checkedAt = performance.now();
        if (signal.aborted) break;
        // The status request has its own deadline and is also stopped at task completion.
        const statusScope = linkedController(statusStop.signal, Math.min(this.statusMs, 8000));
        const cancelStatus = () => statusScope.controller.abort();
        signal.addEventListener('abort', cancelStatus, { once: true });
        try {
          const state = await this.cloud.status(job.id, statusScope.controller.signal);
          if (state !== 'running') { remoteStopped = true; scope.controller.abort(new ConnectorError('cancelled')); break; }
        } finally {
          signal.removeEventListener('abort', cancelStatus);
          statusScope.dispose();
        }
      }
    })().catch(() => {
      if (!statusStop.signal.aborted) { remoteStopped = true; scope.controller.abort(new ConnectorError('cancelled')); }
    });
    try {
      for await (const event of generate(this.providers, job, signal)) await send(event);
    } catch (error) {
      if (!sessionSignal.aborted && !remoteStopped && !deliveryFailed) {
        // A timed-out local request cannot block the fixed failure acknowledgement.
        try { await this.cloud.event(job.id, seq + 1, { type: 'failure', message: FAILURE[error.code] ?? '本地模型请求失败' }, sessionSignal); }
        catch { /* An unacknowledged event must never be replaced or regenerated. */ }
      }
    } finally {
      statusStop.abort();
      scope.controller.abort();
      scope.dispose();
      await monitor;
    }
  }
}
