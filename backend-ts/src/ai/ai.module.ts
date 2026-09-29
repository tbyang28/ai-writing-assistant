import { Module } from '@nestjs/common';

import { AiController } from './ai.controller';
import { AgentService } from './agent/agent.service';
import { StoryToolsService } from './agent/story-tools';
import { StoryMemoryService } from './story-memory.service';
import { RagModule } from '../rag/rag.module';

/**
 * AI 模块 —— 移植自 routers/ai.py 的 8 个端点 + 2 个 agent 端点（工具调用循环）。
 * LLM_CLIENT 与 RagService 都由 RagModule 提供（LLM 客户端挂 DI token 便于测试替换）。
 */
@Module({
  imports: [RagModule],
  controllers: [AiController],
  providers: [StoryMemoryService, StoryToolsService, AgentService],
})
export class AiModule {}
