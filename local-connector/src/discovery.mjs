import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import { HttpTransport } from './http.mjs';

export const PROVIDERS = Object.freeze({
  ollama: Object.freeze({ list: 'http://127.0.0.1:11434/api/tags', show: 'http://127.0.0.1:11434/api/show', chat: 'http://127.0.0.1:11434/v1/chat/completions' }),
  lmstudio: Object.freeze({ list: 'http://127.0.0.1:1234/v1/models', chat: 'http://127.0.0.1:1234/v1/chat/completions' }),
});

export function modelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value);
}

export async function detectClis({ path = process.env.PATH ?? '', platform = process.platform, pathExt = process.env.PATHEXT } = {}) {
  const extensions = platform === 'win32' ? (pathExt ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((s) => /^\.[a-z]+$/i.test(s)) : [''];
  const detected = [];
  for (const name of ['claude', 'codex', 'copilot']) {
    let found = false;
    // Only explicit absolute PATH directories. No current-directory or login/config reads.
    for (const directory of path.split(delimiter).filter(isAbsolute)) {
      for (const extension of extensions) {
        try {
          const candidate = join(directory, name + extension);
          if (!(await stat(candidate)).isFile()) continue;
          await access(candidate, constants.X_OK);
          found = true;
          break;
        } catch { /* Missing or inaccessible is simply not detected. */ }
      }
      if (found) break;
    }
    if (found) detected.push(name);
  }
  return detected;
}

export class LocalProviders {
  constructor({ transport = new HttpTransport(), ollamaKey, lmstudioKey, discoveryTimeoutMs = 1500, generationTimeoutMs = 110_000,
    maxResponseBytes = 4_194_304, cliDetector = detectClis } = {}) {
    this.transport = transport;
    this.keys = { ollama: ollamaKey, lmstudio: lmstudioKey };
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.generationTimeoutMs = generationTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.cliDetector = cliDetector;
    this.inventory = { providers: [], detectedClis: [] };
  }

  headers(provider) {
    const key = this.keys[provider];
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  async discover(signal) {
    const providers = await Promise.all(Object.keys(PROVIDERS).map(async (id) => {
      try {
        const options = { signal, headers: this.headers(id), timeoutMs: this.discoveryTimeoutMs, maxBytes: 524_288 };
        const data = await this.transport.json(PROVIDERS[id].list, options);
        const list = id === 'ollama' ? data.models : data.data;
        if (!Array.isArray(list)) return null;
        const ids = [...new Set(list.map((m) => id === 'ollama' ? m?.name : m?.id).filter(modelId))].slice(0, 20);
        const models = await Promise.all(ids.map(async (model) => {
          const result = { id: model, label: model, tools: false };
          if (id === 'ollama') {
            try {
              const info = await this.transport.json(PROVIDERS.ollama.show, { ...options, method: 'POST', body: { model } });
              result.tools = Array.isArray(info.capabilities) && info.capabilities.includes('tools');
              const contexts = Object.entries(info.model_info ?? {}).filter(([key, value]) =>
                /(?:^|\.)context_length$/.test(key) && Number.isSafeInteger(value) && value >= 2048 && value <= 1_048_576).map(([, value]) => value);
              if (contexts.length) result.contextWindow = Math.min(...contexts);
            } catch { /* A list is not evidence of tools or a context window. */ }
          }
          return result;
        }));
        return { id, models };
      } catch { return null; }
    }));
    const detectedClis = await this.cliDetector();
    if (!signal?.aborted) this.inventory = { providers: providers.filter(Boolean), detectedClis };
    return this.inventory;
  }
}
