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

export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted' | 'unknown';

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface LlmAttempt {
  durationMs: number;
  status: 'completed' | 'failed';
  usage?: LlmUsage;
}

/** 保留原异常类型/错误文案，同时让执行器获知全部失败重试（不含正文）。 */
const failureAttempts = new WeakMap<object, LlmAttempt[]>();
export function recordLlmFailure(error: unknown, attempts: LlmAttempt[]): void {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    failureAttempts.set(error, [...attempts]);
  }
}
export function getLlmFailureAttempts(error: unknown): LlmAttempt[] | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? failureAttempts.get(error) : undefined;
}

export interface LlmResult {
  answer: string;
  toolCalls?: LlmToolCall[];
  finishReason?: LlmFinishReason;
  rawFinishReason?: string;
  usage?: LlmUsage;
  /** 每次上游请求只计一次；失败重试未报告的 usage 保持未知。 */
  attempts?: LlmAttempt[];
}

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'done'; result: LlmResult };

export class LlmIncompleteError extends Error {
  constructor(readonly reason: LlmFinishReason) {
    super(reason === 'length' ? 'AI 输出达到长度上限，结果不完整，请缩小范围后重试' : 'AI 响应未正常完成，请重试');
    this.name = 'LlmIncompleteError';
  }
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
  /** 生产适配器的统一文本/工具流；可选以兼容已有第三方适配器。 */
  streamEvents?(options: LlmCallOptions): AsyncIterable<LlmStreamEvent>;
  /** embeddings 端点（RAG 用），返回与输入等长的向量数组 */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
