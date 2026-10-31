import { Injectable } from '@nestjs/common';

import type { Book } from '../../db/schema';
import { codePointSlice } from '../../shared/text';
import type { ChatMessage } from '../llm/llm-client.interface';
import { SYSTEM_PROMPTS } from '../prompts';
import { AgentRuntimeService, type AgentEvent, type AgentRunResult } from './agent-runtime.service';

export type { AgentEvent, AgentTrace, AgentRunResult } from './agent-runtime.service';

export interface AgentRunOptions {
  book: Book;
  message: string;
  history?: Array<{ role: string; content: string }> | null;
  model?: string;
  signal?: AbortSignal;
  stream?: boolean;
  emit?: (event: AgentEvent) => void | Promise<void>;
}

/** 显式写作 Agent 入口：与普通写作共用执行器，额外开放设定库写入与差异审阅工具。 */
@Injectable()
export class AgentService {
  constructor(private readonly runtime: AgentRuntimeService) {}

  run(options: AgentRunOptions): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPTS.agent },
    ];
    for (const msg of (options.history ?? []).slice(-10)) {
      if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
        messages.push({ role: msg.role, content: msg.content ?? '' });
      }
    }
    messages.push({ role: 'user', content: codePointSlice(options.message, 0, 6000) });
    return this.runtime.run({
      ...options,
      messages,
      allowWrites: true,
    });
  }
}
