import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { DrizzleModule } from '../../db/drizzle.module';
import { AgentProposalsController } from './agent-proposals.controller';
import { AgentProposalsService } from './agent-proposals.service';

/** 由 AiModule imports 接线；不依赖 StoryToolsService 或 AgentRuntimeService。 */
@Module({
  imports: [AuthModule, DrizzleModule],
  controllers: [AgentProposalsController],
  providers: [AgentProposalsService],
  exports: [AgentProposalsService],
})
export class AgentProposalsModule {}
