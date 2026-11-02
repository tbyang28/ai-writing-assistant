import http from 'node:http';
import { type AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SiliconFlowClient } from '../../src/ai/llm/silicon-flow.client';
import { LlmHttpError, getLlmFailureAttempts } from '../../src/ai/llm/llm-client.interface';

/**
 * 真 socket 解析器测试 —— 起一个 node:http 假 SiliconFlow 服务，
 * 专测 undici 客户端的 SSE 逐行缓冲：断行帧、坏 JSON 行、[DONE] 后的垃圾、
 * 非 2xx → LlmHttpError、网络错误重试。
 * 这是唯一不走 DI 替换的 LLM 测试。
 */

let server: http.Server;
let baseUrl = '';
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => {};
/** 收到的请求体（chat/embed 断言用） */
const received: Array<{ body: any; auth?: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      try {
        received.push({ body: JSON.parse(raw), auth: req.headers.authorization });
      } catch {
        received.push({ body: raw });
      }
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(key = 'test-key'): SiliconFlowClient {
  // ConfigService 构造参数即内部配置源，getOrThrow 直接命中
  const config = new ConfigService({
    SILICONFLOW_BASE_URL: baseUrl,
    DEEPSEEK_MODEL: 'test-default-model',
    SILICONFLOW_API_KEY: key,
  });
  return new SiliconFlowClient(config);
}

describe('SiliconFlowClient（真 socket）', () => {
  it('chat：拼装请求体（默认模型/stream=false/max_tokens）并解析 choices', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '你好，世界' } }] }));
    };
    const client = makeClient();
    const result = await client.chat({ messages: [{ role: 'user', content: '问题' }] });
    expect(result.answer).toBe('你好，世界');

    const sent = received.at(-1)!;
    expect(sent.auth).toBe('Bearer test-key');
    expect(sent.body).toEqual({
      model: 'test-default-model',
      messages: [{ role: 'user', content: '问题' }],
      stream: false,
      max_tokens: 4096,
      temperature: 0.7,
    });
    await client.onModuleDestroy();
  });

  it('chat：显式 model/maxTokens/temperature 覆盖默认值', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    };
    const client = makeClient();
    await client.chat({
      messages: [{ role: 'user', content: 'q' }],
      model: 'glm-4',
      maxTokens: 100,
      temperature: 0.35,
    });
    expect(received.at(-1)!.body).toMatchObject({
      model: 'glm-4',
      max_tokens: 100,
      temperature: 0.35,
    });
    await client.onModuleDestroy();
  });

  it('chat：非 2xx → LlmHttpError（带状态码与解析后的 body）', async () => {
    handler = (_req, res) => {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Insufficient balance' }));
    };
    const client = makeClient();
    const promise = client.chat({ messages: [{ role: 'user', content: 'q' }] });
    await expect(promise).rejects.toBeInstanceOf(LlmHttpError);
    await promise.catch((e: LlmHttpError) => {
      expect(e.status).toBe(402);
      expect((e.body as { message: string }).message).toBe('Insufficient balance');
    });
    await client.onModuleDestroy();
  });

  it('chat：网络层错误重试 2 次后成功（HTTP 错误不重试，纯网络错误重试）', async () => {
    let connections = 0;
    handler = (_req, res) => {
      connections += 1;
      if (connections === 1) {
        // 第一次直接掐断连接（网络错误），第二次正常
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '重试成功' } }] }));
    };
    const client = makeClient();
    const result = await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(result.answer).toBe('重试成功');
    expect(connections).toBe(2);
    await client.onModuleDestroy();
  });

  it('chatStream：跨 TCP 块断行、注释行、坏 JSON 行都能正确处理', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 每次只写一小段，故意把一帧拆到多个 TCP 块里
      const pieces = [
        'data: {"choices":[{"delta":{"content":"你"}}]}\n',
        'data: {"choices":[{"del',
        'ta":{"content":"好"}}]}\n',
        ': keep-alive 注释行\n\n',
        'data: {broken json\n',
        'data: {"choices":[{"delta":{}}]}\n', // 空 delta → 不产出
        'data: [DONE]\n',
        'data: {"choices":[{"delta":{"content":"不该出现"}}]}\n',
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i < pieces.length) {
          res.write(pieces[i]);
          i += 1;
        } else {
          clearInterval(timer);
          res.end();
        }
      }, 5);
    };
    const client = makeClient();
    const chunks: string[] = [];
    for await (const chunk of client.chatStream({ messages: [{ role: 'user', content: 'q' }] })) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('你好'); // 断帧拼回、坏帧跳过、[DONE] 后不再产出
    await client.onModuleDestroy();
  });

  it('chatStream：上游 4xx → 抛 LlmHttpError', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'bad api key' }));
    };
    const client = makeClient();
    const iterator = client.chatStream({ messages: [{ role: 'user', content: 'q' }] });
    await expect(iterator.next()).rejects.toBeInstanceOf(LlmHttpError);
    await client.onModuleDestroy();
  });

  it('embed：请求体带 embedding 模型，返回向量数组', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        }),
      );
    };
    const client = makeClient();
    const vectors = await client.embed(['文本一', '文本二']);
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(received.at(-1)!.body).toEqual({
      model: 'BAAI/bge-large-zh-v1.5',
      input: ['文本一', '文本二'],
    });
    await client.onModuleDestroy();
  });

  it('保留 finish_reason 与已知 usage，未知字段不会填零', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ choices: [{ finish_reason: 'length',
      message: { content: '截断', tool_calls: [{ id: 'c1', function: { name: 'save_character', arguments: '{"name":"张三"}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } }));
    const client = makeClient();
    const result = await client.chat({ messages: [] });
    expect(result).toMatchObject({ finishReason: 'length', rawFinishReason: 'length',
      usage: { inputTokens: 12, outputTokens: 8 } });
    expect(result.usage?.cachedInputTokens).toBeUndefined();
    expect(result.attempts).toHaveLength(1);
    await client.onModuleDestroy();
  });

  it('统一流组装交错工具参数，读取结束后的 usage，处理无换行 DONE', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of [
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'get_outline', arguments: '{' } },
          { index: 0, id: 'a', function: { name: 'get_characters', arguments: '{"names":[' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"张三"]}' } },
          { index: 1, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } } },
      ]) res.write(`data: ${JSON.stringify(frame)}\r\n\r\n`);
      res.end('data: [DONE]');
    };
    const client = makeClient();
    const events = [];
    for await (const event of client.streamEvents({ messages: [] })) events.push(event);
    const done = events.at(-1)!;
    expect(done.type).toBe('done');
    if (done.type === 'done') {
      expect(done.result).toMatchObject({ finishReason: 'tool_calls', usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 3 } });
      expect(done.result.toolCalls).toEqual([
        { id: 'a', name: 'get_characters', argumentsJson: '{"names":["张三"]}' },
        { id: 'b', name: 'get_outline', argumentsJson: '{}' },
      ]);
    }
    await client.onModuleDestroy();
  });

  it('缺少终态的断流抛错，不把半段文本标记完成', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"半段"}}]}\n\n');
    };
    const client = makeClient();
    await expect((async () => { for await (const _ of client.streamEvents({ messages: [] })) { /* consume */ } })())
      .rejects.toThrow('未正常完成');
    await client.onModuleDestroy();
  });

  it('取消正在进行的 embedding HTTP，不发起重试', async () => {
    const controller = new AbortController();
    let requests = 0;
    handler = (_req, _res) => { requests++; controller.abort(); };
    const client = makeClient();
    await expect(client.embed(['取消检索'], controller.signal)).rejects.toThrow();
    expect(requests).toBe(1);
    await client.onModuleDestroy();
  });

  it('全部网络重试失败仍保留三次尝试，usage 保持未知', async () => {
    let count = 0;
    handler = (_req, res) => { count++; res.destroy(); };
    const client = makeClient();
    try {
      const error = await client.chat({ messages: [] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(count).toBe(3);
      expect(getLlmFailureAttempts(error)).toHaveLength(3);
      expect(getLlmFailureAttempts(error)?.every((a) => a.status === 'failed' && a.usage === undefined)).toBe(true);
    } finally { await client.onModuleDestroy(); }
  });

  it.each([false, true])('带工具但缺少可信结束原因时拒绝响应，stream=%s', async (stream) => {
    handler = (_req, res) => {
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"get_outline","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n');
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
          { id: 'a', function: { name: 'get_outline', arguments: '{}' } },
        ] } }] }));
      }
    };
    const client = makeClient();
    try {
      const consume = async () => { for await (const _ of client.streamEvents({ messages: [] })) { /* consume */ } };
      await expect(stream ? consume() : client.chat({ messages: [] })).rejects.toThrow('未正常完成');
    } finally { await client.onModuleDestroy(); }
  });

  it('未配置 API Key → 抛中文提示，不发请求', async () => {
    const client = makeClient('');
    const promise = client.chat({ messages: [{ role: 'user', content: 'q' }] });
    await expect(promise).rejects.toThrow('Render 后端未配置 SILICONFLOW_API_KEY');
    await client.onModuleDestroy();
  });
});
