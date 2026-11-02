import { Injectable } from '@nestjs/common';
import { LocalProvidersService } from '../../local-providers/local-providers.service';
import { LocalJobBroker } from '../../local-providers/local-job-broker';
import { parseLocalModel } from '../../local-providers/protocol';
import { SiliconFlowClient } from './silicon-flow.client';
import { LlmIncompleteError, recordLlmFailure, type LlmCallOptions, type LlmClient,
  type LlmResult, type LlmStreamEvent } from './llm-client.interface';

/** 本机调用每次重新校验账号/连接状态；错误直接返回，不切换到云端。 */
@Injectable()
export class RoutedLlmClient implements LlmClient {
  constructor(private readonly cloud: SiliconFlowClient, private readonly providers: LocalProvidersService,
    private readonly jobs: LocalJobBroker) {}

  async modelCapabilities(model?: string, accountId?: string) {
    const target = await this.providers.resolve(accountId, model);
    return target ? { tools: target.tools, contextWindow: target.contextWindow } : { tools: true };
  }
  async chat(options: LlmCallOptions): Promise<LlmResult> {
    if (!parseLocalModel(options.model)) return this.cloud.chat(options);
    let result: LlmResult | undefined;
    for await (const event of this.streamEvents(options)) if (event.type === 'done') result = event.result;
    if (!result) throw new LlmIncompleteError('error');
    return result;
  }
  async *chatStream(options: LlmCallOptions): AsyncIterable<string> {
    if (!parseLocalModel(options.model)) { yield* this.cloud.chatStream(options); return; }
    for await (const event of this.streamEvents(options)) {
      if (event.type === 'text') yield event.text;
      if (event.type === 'done' && event.result.finishReason !== 'stop') throw new LlmIncompleteError(event.result.finishReason ?? 'unknown');
    }
  }
  async *streamEvents(options: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
    if (!parseLocalModel(options.model)) { yield* this.cloud.streamEvents(options); return; }
    const target = await this.providers.resolve(options.accountId, options.model);
    if (!target) throw new Error('本机模型标识无效');
    if (options.tools?.length && !target.tools) throw new Error('此本机模型尚未确认工具调用能力');
    const started = performance.now();
    try {
      for await (const event of this.jobs.run(target.connectionId, {
        provider: target.provider, model: target.model, messages: options.messages,
        ...(options.tools?.length ? { tools: options.tools } : {}),
        maxTokens: options.maxTokens ?? 4096, temperature: options.temperature ?? 0.7,
      }, options.signal)) {
        if (event.type === 'done') yield { type: 'done', result: { ...event.result,
          attempts: [{ status: 'completed', durationMs: performance.now() - started, usage: event.result.usage }] } };
        else yield event;
      }
    } catch (error) {
      recordLlmFailure(error, [{ status: 'failed', durationMs: performance.now() - started }]);
      throw error;
    }
  }
  embed(texts: string[], signal?: AbortSignal) { return this.cloud.embed(texts, signal); }
}
