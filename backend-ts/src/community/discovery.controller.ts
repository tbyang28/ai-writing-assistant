import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../core/current-user.decorator";
import { ParseUuidOr404Pipe } from "../core/parse-uuid-or-404.pipe";
import { ZodValidationPipe } from "../core/zod-validation.pipe";
import type { User } from "../db/schema";
import { CommunityService } from "./community.service";
import { feedQuerySchema, searchQuerySchema } from "./dto";
import { OptionalJwtGuard } from "./optional-jwt.guard";
@Controller("community")
@UseGuards(OptionalJwtGuard)
export class DiscoveryController {
  constructor(private readonly community: CommunityService) {}
  @Get("feed")
  feed(
    @Query(new ZodValidationPipe(feedQuerySchema)) query: any,
    @CurrentUser() user?: User,
  ) {
    return this.community.listFeed(query, user?.id);
  }
  @Get("search")
  search(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: any,
    @CurrentUser() user?: User,
  ) {
    return this.community.search(query, user?.id);
  }
  @Get("books/:id")
  getBook(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user?: User,
  ) {
    return this.community.getPublicBook(id, user?.id);
  }
  @Get("books/:id/chapters")
  chapters(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user?: User,
  ) {
    return this.community.listChapters(id, user?.id);
  }
  @Get("chapters/:id")
  getChapter(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user?: User,
  ) {
    return this.community.getPublicChapter(id, user?.id);
  }
  @Get("users/:id")
  getProfile(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user?: User,
  ) {
    return this.community.getProfile(id, user?.id);
  }
}
