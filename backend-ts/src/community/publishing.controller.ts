import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../core/current-user.decorator";
import { ParseUuidOr404Pipe } from "../core/parse-uuid-or-404.pipe";
import { ZodValidationPipe } from "../core/zod-validation.pipe";
import type { User } from "../db/schema";
import { CommunityService } from "./community.service";
import { publishSchema } from "./dto";
@Controller("books")
@UseGuards(JwtAuthGuard)
export class PublishingController {
  constructor(private readonly community: CommunityService) {}
  @Post(":id/publish")
  publish(
    @Param("id", new ParseUuidOr404Pipe("作品不存在")) id: string,
    @Body(new ZodValidationPipe(publishSchema)) body: any,
    @CurrentUser() user: User,
  ) {
    return this.community.publishBook(id, user.id, body);
  }
}
