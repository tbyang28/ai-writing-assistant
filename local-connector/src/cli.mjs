#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ConnectorError } from './http.mjs';
import { LocalProviders } from './discovery.mjs';
import { CloudRuntime, ConnectorRuntime, validateApiRoot } from './runtime.mjs';

const HELP = `AI 写作本机模型连接器（Node >=20）

npm start -- --server https://your-site.example/api [--name 我的电脑]

--server    云端 API root，也可用 AI_WRITING_API_ROOT；明确 loopback 开发地址可 HTTP
--api-root  --server 的别名
--name      手动指定设备名，默认“我的电脑”
--help      显示帮助

配对码从交互输入或 AI_WRITING_PAIR_CODE 读取，每次启动重新配对。
可选本机密钥：AI_WRITING_OLLAMA_API_KEY / AI_WRITING_LMSTUDIO_API_KEY。
保持标准输入打开；Ctrl+C、SIGTERM 或标准输入结束会取消请求并退出。
`;

export function parseArgs(args, env = process.env) {
  const result = { apiRoot: env.AI_WRITING_API_ROOT, name: '我的电脑', help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' && args.length === 1) return { ...result, help: true };
    const key = ['--server', '--api-root'].includes(arg) ? 'apiRoot' : arg === '--name' ? 'name' : undefined;
    if (!key || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new ConnectorError('invalid_arguments');
    seen.add(key);
    result[key] = args[++i];
  }
  result.apiRoot = validateApiRoot(result.apiRoot);
  if (!result.name.trim() || result.name.length > 60 || /[\x00-\x1f\x7f]/.test(result.name)) throw new ConnectorError('invalid_name');
  return result;
}

export async function main({ args = process.argv.slice(2), env = process.env, input = process.stdin, output = process.stderr,
  signals = process, providersFactory = (options) => new LocalProviders(options), cloudFactory = (options) => new CloudRuntime(options),
  runtimeFactory = (options) => new ConnectorRuntime(options) } = {}) {
  let options;
  const log = (message) => output.write(`${message}\n`);
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new ConnectorError('unsupported_node');
    options = parseArgs(args, env);
    if (options.help) { output.write(HELP); return 0; }
  } catch {
    log('启动参数无效。请使用 --help 查看用法（API root 必须为 HTTPS，或明确的 loopback 开发地址）。');
    return 1;
  }
  log('本连接器仅出站连接云端，不监听本机端口。将上传手动设备名、本机模型清单与已知 CLI 的存在信息。');
  log('网页启用连接后，作品上下文会经云端发送到本机模型，生成文本和工具提案会返回云端；工具由服务端验证执行。');
  log('仅访问 Ollama 127.0.0.1:11434 / LM Studio 127.0.0.1:1234；本机 API 密钥不会上传。RAG/向量检索仍使用服务端配置。');
  const controller = new AbortController();
  const stop = () => controller.abort(new ConnectorError('cancelled'));
  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  const closed = () => stop();
  lines.on('close', closed);
  input.on('error', stop);
  signals.on('SIGINT', stop);
  signals.on('SIGTERM', stop);
  let code = env.AI_WRITING_PAIR_CODE;
  try {
    if (input.readableEnded || input.destroyed) stop();
    if (!code) {
      output.write('输入网页上的一次性配对码：');
      code = await new Promise((resolve, reject) => {
        const onLine = (line) => { cleanup(); resolve(line.trim()); };
        const onAbort = () => { cleanup(); reject(new ConnectorError('cancelled')); };
        function cleanup() { lines.removeListener('line', onLine); controller.signal.removeEventListener('abort', onAbort); }
        lines.once('line', onLine);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
    }
    const providers = providersFactory({ ollamaKey: env.AI_WRITING_OLLAMA_API_KEY, lmstudioKey: env.AI_WRITING_LMSTUDIO_API_KEY });
    const cloud = cloudFactory({ apiRoot: options.apiRoot });
    const runtime = runtimeFactory({ cloud, providers, log });
    const pending = runtime.run({ code, name: options.name, signal: controller.signal });
    code = undefined;
    await pending;
    return 0;
  } catch {
    if (controller.signal.aborted) return 0;
    log('连接器已停止。请检查配对码、云端连接与本机模型服务后重新启动。');
    return 1;
  } finally {
    code = undefined;
    stop();
    lines.removeListener('close', closed);
    lines.close();
    input.removeListener('error', stop);
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
