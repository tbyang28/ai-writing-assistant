/** LLM 客户端 DI token —— 测试用 overrideProvider(LLM_CLIENT) 替换成假实现 */
export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface ChatMessage {
  role: string;
  content: string;
}

export interface LlmCallOptions {
  messages: ChatMessage[];
  model?: string;
  /** 默认 4096 */
  maxTokens?: number;
  /** 默认 0.7 */
  temperature?: number;
}

export interface LlmResult {
  answer: string;
}

/**
 * 上游 HTTP 非 2xx —— 对应 httpx 的 raise_for_status() 抛出的 HTTPStatusError，
 * 携带状态码与（尽力解析的）响应体，供 extractAiError 产出与 Python 一致的文案。
 */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly bodyText: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'LlmHttpError';
  }
}

/** 与 SiliconFlow 交互的最小接口：chat / chatStream / embed */
export interface LlmClient {
  chat(options: LlmCallOptions): Promise<LlmResult>;
  chatStream(options: LlmCallOptions): AsyncIterable<string>;
  /** embeddings 端点（RAG 用），返回与输入等长的向量数组 */
  embed(texts: string[]): Promise<number[][]>;
}
