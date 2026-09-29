import { Inject, Injectable } from '@nestjs/common';

import type { Book } from '../../db/schema';
import { codePointSlice } from '../../shared/text';
import {
  LLM_CLIENT,
  type ChatMessage,
  type LlmClient,
  type LlmToolCall,
} from '../llm/llm-client.interface';
import { SYSTEM_PROMPTS } from '../prompts';
import { StoryToolsService } from './story-tools';

/** 工具调用轮数上限：防模型陷入「永远想再查一点」的死循环，也控制 token 消耗 */
const MAX_ROUNDS = 4;
/** 每轮最多执行几个工具调用 */
const MAX_TOOLS_PER_ROUND = 3;
/** 最终答案作为 token 事件回放时的块大小（字符） */
const FINAL_CHUNK_CHARS = 60;

/**
 * Agent 向外部（controller → SSE / 非流式响应）汇报的事件。
 * step：一轮决策完成（thought 是模型该轮的前导文本）
 * tool_call / tool_result：工具调用与结果预览
 * token：最终回答文本
 */
export type AgentEvent =
  | { type: 'step'; round: number; thought: string }
  | { type: 'tool_call'; round: number; name: string; args: Record<string, unknown> | null }
  | { type: 'tool_result'; round: number; name: string; ok: boolean; preview: string }
  | { type: 'token'; text: string };

export interface AgentTrace {
  round: number;
  thought: string;
  tools: Array<{ name: string; ok: boolean }>;
}

export interface AgentRunOptions {
  book: Book;
  /** 用户消息（controller 已拼入当前草稿等最小上下文） */
  message: string;
  history?: Array<{ role: string; content: string }> | null;
  model?: string;
  signal?: AbortSignal;
  emit?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  answer: string;
  trace: AgentTrace[];
  /** 实际消耗的 LLM 调用轮数 */
  rounds: number;
}

/**
 * 写作 Agent —— tool-calling 循环。
 *
 * 每轮：把 messages + 工具规格发给模型 →
 *   模型返回 tool_calls → 本地执行工具、结果作为 role:'tool' 消息回灌 → 下一轮；
 *   模型不再请求工具 → 该轮的 content 就是最终回答。
 *
 * 设计取舍：轮内用非流式 chat（tool_calls 的流式增量解析复杂且各上游实现不一，
 * 为兼容性放弃）；最终回答通过 token 事件一次性回放，SSE 端点靠 step/tool 事件
 * 在等待期间持续给出反馈。
 */
@Injectable()
export class AgentService {
  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly tools: StoryToolsService,
  ) {}

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const emit = options.emit ?? (() => undefined);
    const messages = this.buildInitialMessages(options);
    const trace: AgentTrace[] = [];

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (options.signal?.aborted) {
        return { answer: '', trace, rounds: round - 1 };
      }
      const res = await this.llm.chat({
        messages,
        model: options.model,
        tools: this.tools.specs,
        signal: options.signal,
      });
      const thought = (res.answer ?? '').trim();

      if (!res.toolCalls?.length) {
        // 最终回答：按码点切块回放为 token 事件（非流轮内已拿到全文）
        const answer = res.answer ?? '';
        const chars = Array.from(answer);
        for (let i = 0; i < chars.length; i += FINAL_CHUNK_CHARS) {
          emit({ type: 'token', text: chars.slice(i, i + FINAL_CHUNK_CHARS).join('') });
        }
        return { answer, trace, rounds: round };
      }

      const entry: AgentTrace = { round, thought, tools: [] };
      trace.push(entry);
      emit({ type: 'step', round, thought: codePointSlice(thought, 0, 300) });
      messages.push({ role: 'assistant', content: res.answer ?? '', toolCalls: res.toolCalls });

      for (const call of res.toolCalls.slice(0, MAX_TOOLS_PER_ROUND)) {
        const args = safeParseArgs(call);
        emit({ type: 'tool_call', round, name: call.name, args });

        const result = await this.tools.execute(call.name, args ?? {}, options.book);
        entry.tools.push({ name: call.name, ok: result.ok });
        emit({
          type: 'tool_result',
          round,
          name: call.name,
          ok: result.ok,
          preview: codePointSlice(result.content, 0, 200),
        });

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
        });
      }
    }

    // 轮数耗尽：摘掉工具表，要求基于已收集的信息直接作答（最后一轮）
    messages.push({
      role: 'system',
      content: '工具调用已达上限。请基于目前已收集的信息直接给出最终回答，不要再请求工具。',
    });
    const res = await this.llm.chat({
      messages,
      model: options.model,
      signal: options.signal,
    });
    const answer = res.answer ?? '';
    if (answer) {
      emit({ type: 'token', text: answer });
    }
    return { answer, trace, rounds: MAX_ROUNDS + 1 };
  }

  /**
   * 与 story-memory 的分水岭：初始上下文只放「作品名/简介/用户问题」，
   * 人物/大纲/前文全靠模型自己调工具取——它决定自己需要什么。
   */
  private buildInitialMessages(options: AgentRunOptions): ChatMessage[] {
    const { book } = options;
    const bookInfo: string[] = [`【当前作品】${book.title}`];
    if (book.description) {
      bookInfo.push(`简介：${codePointSlice(book.description, 0, 300)}`);
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPTS.agent },
      { role: 'system', content: bookInfo.join('\n') },
    ];
    for (const msg of (options.history ?? []).slice(-10)) {
      if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
        messages.push({ role: msg.role, content: msg.content ?? '' });
      }
    }
    messages.push({ role: 'user', content: codePointSlice(options.message, 0, 6000) });
    return messages;
  }
}

/** tool_calls 的 arguments 是「模型生成的 JSON 字符串」，解析失败按 null 处理（容错喂回） */
function safeParseArgs(call: LlmToolCall): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(call.argumentsJson || '{}') as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
