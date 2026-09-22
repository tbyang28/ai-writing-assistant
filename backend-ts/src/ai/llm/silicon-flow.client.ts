import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, request, type Dispatcher } from 'undici';

type UndiciResponse = Dispatcher.ResponseData<null>;

import {
  LlmHttpError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResult,
} from './llm-client.interface';

/** SiliconFlow 的 embedding 模型（Python 版硬编码一致） */
export const EMBEDDING_MODEL = 'BAAI/bge-large-zh-v1.5';

/**
 * SiliconFlow 客户端 —— 对应 ai_service.py 的 call_siliconflow / _stream_response
 * 和 rag_service.py 的 embed_text（共用同一个 httpx 客户端 → 这里共用一个 undici Agent）。
 *
 * Agent 参数对齐 Python 版 httpx 配置：
 *   connections 10 / connect 15s / 总超时 180s（headersTimeout）
 * undici 默认不走系统代理 env —— 等价 httpx trust_env=False（「Proxy 修复」）。
 * 非流式请求带 2 次网络层重试（httpx AsyncHTTPTransport(retries=2)）。
 */
@Injectable()
export class SiliconFlowClient implements LlmClient, OnModuleDestroy {
  private readonly agent = new Agent({
    connections: 10,
    connect: { timeout: 15_000 },
    headersTimeout: 180_000,
    bodyTimeout: 300_000,
  });

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    await this.agent.close();
  }

  private baseUrl(): string {
    return this.config.getOrThrow<string>('SILICONFLOW_BASE_URL');
  }

  private defaultModel(): string {
    return this.config.getOrThrow<string>('DEEPSEEK_MODEL');
  }

  private requireApiKey(): string {
    const key = this.config.getOrThrow<string>('SILICONFLOW_API_KEY');
    if (!key) {
      throw new Error('Render 后端未配置 SILICONFLOW_API_KEY，无法调用 AI 服务');
    }
    return key;
  }

  private buildBody(options: LlmCallOptions, stream: boolean): string {
    return JSON.stringify({
      model: options.model ?? this.defaultModel(),
      messages: options.messages,
      stream,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    });
  }

  private post(path: string, body: string, signal?: AbortSignal): Promise<UndiciResponse> {
    return request(`${this.baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.requireApiKey()}`,
        'content-type': 'application/json',
      },
      body,
      dispatcher: this.agent,
      signal,
    });
  }

  /** 非 2xx → LlmHttpError（等价 httpx raise_for_status） */
  private static async httpError(res: UndiciResponse): Promise<LlmHttpError> {
    const bodyText = await res.body.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = undefined;
    }
    return new LlmHttpError(res.statusCode, body, bodyText);
  }

  async chat(options: LlmCallOptions): Promise<LlmResult> {
    const body = this.buildBody(options, false);
    // 网络层错误重试 2 次（HTTP 状态错误不重试）；已取消的调用不再重试
    return this.withRetry(async () => {
      if (options.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const res = await this.post('/chat/completions', body, options.signal);
      if (res.statusCode >= 400) {
        throw await SiliconFlowClient.httpError(res);
      }
      const data = (await res.body.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return { answer: data.choices[0].message.content };
    });
  }

  async *chatStream(options: LlmCallOptions): AsyncIterable<string> {
    const res = await this.post('/chat/completions', this.buildBody(options, true), options.signal);
    if (res.statusCode >= 400) {
      throw await SiliconFlowClient.httpError(res);
    }

    // 逐行解析 SSE —— 对应 _stream_response 的 aiter_lines 循环：
    // "data: " 前缀、"[DONE]" 哨兵、坏帧跳过
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk as Buffer, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');

          if (!line.startsWith('data: ')) {
            continue;
          }
          const dataStr = line.slice('data: '.length);
          if (dataStr.trim() === '[DONE]') {
            return;
          }
          try {
            const data = JSON.parse(dataStr) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const content = data.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
            continue;
          }
        }
      }
    } finally {
      // 中途 return（[DONE] 或消费方 break）时排空连接以便复用
      await res.body.dump().catch(() => undefined);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const body = JSON.stringify({ model: EMBEDDING_MODEL, input: texts });
    return this.withRetry(async () => {
      const res = await this.post('/embeddings', body);
      if (res.statusCode >= 400) {
        throw await SiliconFlowClient.httpError(res);
      }
      const data = (await res.body.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      return data.data.map((item) => item.embedding);
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (error instanceof LlmHttpError) {
          throw error; // 上游明确拒绝，重试无意义
        }
      }
    }
    throw lastError;
  }
}
