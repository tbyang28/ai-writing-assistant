import { Module } from '@nestjs/common';

import { LLM_CLIENT } from '../ai/llm/llm-client.interface';
import { SiliconFlowClient } from '../ai/llm/silicon-flow.client';
import { RoutedLlmClient } from '../ai/llm/routed-llm.client';
import { LocalProvidersModule } from '../local-providers/local-providers.module';
import { RagService } from './rag.service';

/**
 * RAG 模块 —— 被 Books（章节保存时索引）和 Ai（story memory 检索）共同消费，
 * LLM_CLIENT 在这里注册一次。
 */
@Module({
  imports: [LocalProvidersModule],
  providers: [
    SiliconFlowClient,
    { provide: LLM_CLIENT, useClass: RoutedLlmClient },
    RagService,
  ],
  exports: [LLM_CLIENT, RagService],
})
export class RagModule {}
