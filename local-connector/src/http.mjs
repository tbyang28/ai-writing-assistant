// No upstream error text is retained: errors are safe to display or forward.
export class ConnectorError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'ConnectorError';
    this.code = code;
    this.status = status;
  }
}

export function abortError() { return new ConnectorError('cancelled'); }

export function linkedController(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason instanceof ConnectorError ? signal.reason : abortError());
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new ConnectorError('timeout')), timeoutMs);
  return {
    controller,
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
  };
}

export async function abortable(promise, signal) {
  if (signal.aborted) throw signal.reason ?? abortError();
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// The deadline includes fetch, response consumption, and downstream backpressure.
export class HttpTransport {
  constructor({ fetchImpl = globalThis.fetch } = {}) { this.fetchImpl = fetchImpl; }

  async *bytes(url, { method = 'GET', body, headers = {}, signal,
    timeoutMs = 5000, maxBytes = 1_048_576 } = {}) {
    const scope = linkedController(signal, timeoutMs);
    const localSignal = scope.controller.signal;
    let response, reader;
    try {
      localSignal.throwIfAborted();
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded !== undefined && Buffer.byteLength(encoded) > 2_097_152) throw new ConnectorError('request_limit');
      const fetching = Promise.resolve().then(() => this.fetchImpl(url, {
        method, body: encoded, headers: { ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        redirect: 'manual', signal: localSignal,
      }));
      // An injected or delayed fetch may settle after the deadline; release its body too.
      fetching.then((res) => { if (localSignal.aborted) void res.body?.cancel().catch(() => {}); }, () => {});
      response = await abortable(fetching, localSignal);
      if (!response.ok || response.redirected) throw new ConnectorError('http', response.status);
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new ConnectorError('body_limit');
      if (!response.body) throw new ConnectorError('invalid_response');
      reader = response.body.getReader();
      let total = 0;
      for (;;) {
        const chunk = await abortable(reader.read(), localSignal);
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) throw new ConnectorError('body_limit');
        yield chunk.value;
        if (localSignal.aborted) throw localSignal.reason;
      }
    } catch (error) {
      if (localSignal.aborted) throw localSignal.reason;
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('network');
    } finally {
      scope.controller.abort(abortError());
      if (reader) { void reader.cancel().catch(() => {}); }
      else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      scope.dispose();
    }
  }

  async json(url, options) {
    const chunks = [];
    for await (const chunk of this.bytes(url, options)) chunks.push(Buffer.from(chunk));
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ConnectorError('invalid_response'); }
  }
}
