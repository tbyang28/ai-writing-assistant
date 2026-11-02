import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser } from '../../core/current-user.decorator';
import { ParseUuidOr404Pipe } from '../../core/parse-uuid-or-404.pipe';
import { ZodValidationPipe } from '../../core/zod-validation.pipe';
import type { User } from '../../db/schema';
import { AgentProposalsService, proposalDigestSchema } from './agent-proposals.service';

/** 不提供公开 create 路由：提案来自受书籍归属校验约束的 Agent Runtime。 */
@Controller('ai/proposals')
@UseGuards(JwtAuthGuard)
export class AgentProposalsController {
  constructor(private readonly proposals: AgentProposalsService) {}

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @Param('id', new ParseUuidOr404Pipe('提案不存在')) id: string,
    @Body(new ZodValidationPipe(proposalDigestSchema)) body: { digest: string },
    @CurrentUser() user: User,
  ) {
    return this.proposals.confirm(id, user.id, body.digest);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', new ParseUuidOr404Pipe('提案不存在')) id: string,
    @Body(new ZodValidationPipe(proposalDigestSchema)) body: { digest: string },
    @CurrentUser() user: User,
  ) {
    return this.proposals.cancel(id, user.id, body.digest);
  }
}
