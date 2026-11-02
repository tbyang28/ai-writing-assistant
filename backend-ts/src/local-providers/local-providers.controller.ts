import { Body, ConflictException, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../core/current-user.decorator';
import { ParseUuidOr404Pipe } from '../core/parse-uuid-or-404.pipe';
import { ZodValidationPipe } from '../core/zod-validation.pipe';
import type { User } from '../db/schema';
import { LocalProvidersService } from './local-providers.service';
import { LocalJobBroker } from './local-job-broker';
import { enableSchema, eventRequestSchema, pairSchema, pollSchema } from './protocol';

@Controller('local-providers')
@UseGuards(JwtAuthGuard)
export class LocalProvidersController {
  constructor(private readonly providers: LocalProvidersService) {}
  @Get() list(@CurrentUser() user: User) { return this.providers.list(user.id); }
  @Post('pairing') @HttpCode(200)
  pairing(@Body(new ZodValidationPipe(z.object({}).strict())) _body: object, @CurrentUser() user: User) {
    return this.providers.createPairing(user.id);
  }
  @Put('connections/:id')
  update(@Param('id', new ParseUuidOr404Pipe('连接不存在')) id: string,
    @Body(new ZodValidationPipe(enableSchema)) body: z.infer<typeof enableSchema>, @CurrentUser() user: User) {
    return this.providers.update(user.id, id, body.enabled);
  }
  @Delete('connections/:id') @HttpCode(204)
  revoke(@Param('id', new ParseUuidOr404Pipe('连接不存在')) id: string, @CurrentUser() user: User) {
    return this.providers.revoke(user.id, id);
  }
}

/** 受限 runtime 令牌只可拉取本连接任务，永远不能使用账号 API 或确认 Agent 写入。 */
@Controller('local-runtime')
export class LocalRuntimeController {
  constructor(private readonly providers: LocalProvidersService, private readonly jobs: LocalJobBroker) {}
  @Post('pair') @HttpCode(200)
  pair(@Body(new ZodValidationPipe(pairSchema)) body: z.infer<typeof pairSchema>) { return this.providers.pair(body); }
  @Post('poll') @HttpCode(200)
  async poll(@Headers('authorization') token: string | undefined,
    @Body(new ZodValidationPipe(pollSchema)) body: z.infer<typeof pollSchema>) {
    const connection = await this.providers.authenticate(token);
    return this.providers.poll(connection, body.inventory);
  }
  @Get('jobs/:id/status')
  async status(@Headers('authorization') token: string | undefined,
    @Param('id', new ParseUuidOr404Pipe('任务不存在')) id: string) {
    const connection = await this.providers.authenticate(token);
    const result = this.jobs.status(connection.id, id);
    return connection.enabled ? result : { status: 'cancelled' };
  }
  @Post('jobs/:id/events') @HttpCode(200)
  async events(@Headers('authorization') token: string | undefined,
    @Param('id', new ParseUuidOr404Pipe('任务不存在')) id: string,
    @Body(new ZodValidationPipe(eventRequestSchema)) body: z.infer<typeof eventRequestSchema>) {
    const connection = await this.providers.authenticate(token);
    if (!connection.enabled) throw new ConflictException('连接已停用');
    this.jobs.accept(connection.id, id, body.seq, body.event);
    return { accepted: true };
  }
}
