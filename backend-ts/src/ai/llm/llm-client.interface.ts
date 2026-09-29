/** LLM 客户端 DI token —— 测试用 overrideProvider(LLM_CLIENT) 替换成假实现 */
export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface ChatMessage {
  role: string;
  content: string;
  /** role:'assistant' 且模型请求工具时携带；下一轮原样回传 */
  toolCalls?: LlmToolCall[];
  /** role:'tool' 的工具结果消息：对应哪次调用 + 工具名 */
  toolCallId?: string;
  toolName?: string;
}

/** OpenAI 兼容 function-tool 规格（请求体 tools[] 里 function 字段的内容） */
export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema 参数描述 */
  parameters: Record<string, unknown>;
}

/** 模型返回的一次工具调用请求（assistant 消息 tool_calls 的一项） */
export interface LlmToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串参数（agent 层负责解析与容错） */
  argumentsJson: string;
}

export interface LlmCallOptions {
  messages: ChatMessage[];
  model?: string;
  /** 默认 4096 */
  maxTokens?: number;
  /** 默认 0.7 */
  temperature?: number;
  /** 取消信号：SSE 客户端断开时中止上游请求，不再白烧 token */
  signal?: AbortSignal;
  /** 工具规格（agent 模式）；给出时走 OpenAI 兼容 function calling */
  tools?: LlmToolSpec[];
}

export interface LlmResult {
  answer: string;
  /** 模型本轮请求的工具调用；为空表示这一轮就是最终回答 */
  toolCalls?: LlmToolCall[];
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
