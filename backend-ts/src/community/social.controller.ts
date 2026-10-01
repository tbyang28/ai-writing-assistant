import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";

import { OptionalJwtGuard } from "./optional-jwt.guard";
import { ParseUuidOr404Pipe } from "../core/parse-uuid-or-404.pipe";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../core/current-user.decorator";
import { ZodValidationPipe } from "../core/zod-validation.pipe";
import type { User } from "../db/schema";
import { CommunityService } from "./community.service";
import {
  feedQuerySchema,
  commentSchema,
  profileUpdateSchema,
  progressSchema,
  publishSchema,
  reportSchema,
} from "./dto";

@Controller("community")
export class SocialController {
  constructor(private readonly community: CommunityService) {}

  @Post("/books/:id/publish")
  @UseGuards(JwtAuthGuard)
  publish(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @Body(new ZodValidationPipe(publishSchema)) body: any,
    @CurrentUser() user: User,
  ) {
    return this.community.publishBook(id, user.id, body);
  }

  @Post("users/:id/follow")
  @UseGuards(JwtAuthGuard)
  follow(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.toggleFollow(id, user.id, true);
  }

  @Delete("users/:id/follow")
  @UseGuards(JwtAuthGuard)
  unfollow(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.toggleFollow(id, user.id, false);
  }

  @Post("users/:id/block")
  @UseGuards(JwtAuthGuard)
  block(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.toggleBlock(id, user.id, true);
  }

  @Delete("users/:id/block")
  @UseGuards(JwtAuthGuard)
  unblock(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.toggleBlock(id, user.id, false);
  }

  @Post("books/:id/like")
  @UseGuards(JwtAuthGuard)
  like(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.toggleBook(id, user.id, "like", true);
  }

  @Delete("books/:id/like")
  @UseGuards(JwtAuthGuard)
  unlike(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.toggleBook(id, user.id, "like", false);
  }

  @Post("books/:id/favorite")
  @UseGuards(JwtAuthGuard)
  favorite(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.toggleBook(id, user.id, "favorite", true);
  }

  @Delete("books/:id/favorite")
  @UseGuards(JwtAuthGuard)
  unfavorite(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.toggleBook(id, user.id, "favorite", false);
  }

  @Get("books/:id/comments")
  @UseGuards(OptionalJwtGuard)
  comments(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user?: User,
  ) {
    return this.community.listComments(id, undefined, user?.id);
  }

  @Post("books/:id/comments")
  @UseGuards(JwtAuthGuard)
  comment(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @Body(new ZodValidationPipe(commentSchema)) body: any,
    @CurrentUser() user: User,
  ) {
    return this.community.createComment(id, null, user.id, body);
  }

  @Get("chapters/:id/comments")
  @UseGuards(OptionalJwtGuard)
  chapterComments(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user?: User,
  ) {
    return this.community.listCommentsForChapter(id, user?.id);
  }

  @Post("chapters/:id/comments")
  @UseGuards(JwtAuthGuard)
  chapterComment(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @Body(new ZodValidationPipe(commentSchema)) body: any,
    @CurrentUser() user: User,
  ) {
    return this.community.createChapterComment(id, user.id, body);
  }

  @Delete("comments/:id")
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  deleteComment(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.deleteComment(id, user.id);
  }

  @Post("comments/:id/pin")
  @UseGuards(JwtAuthGuard)
  pin(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.pinComment(id, user.id, true);
  }

  @Delete("comments/:id/pin")
  @UseGuards(JwtAuthGuard)
  unpin(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @CurrentUser() user: User,
  ) {
    return this.community.pinComment(id, user.id, false);
  }

  @Post("books/:id/progress")
  @UseGuards(JwtAuthGuard)
  progress(
    @Param("id", new ParseUuidOr404Pipe("内容不存在")) id: string,
    @Body(new ZodValidationPipe(progressSchema)) body: any,
    @CurrentUser() user: User,
  ) {
    return this.community.saveProgress(
      id,
      user.id,
      body.chapter_id,
      body.position,
    );
  }

  @Get("favorites")
  @UseGuards(JwtAuthGuard)
  favorites(
    @CurrentUser() user: User,
    @Query(new ZodValidationPipe(feedQuerySchema)) query: any,
  ) {
    return this.community.listFavorites(user.id, query);
  }

  @Get("notifications")
  @UseGuards(JwtAuthGuard)
  notifications(
    @CurrentUser() user: User,
    @Query(new ZodValidationPipe(feedQuerySchema)) query: any,
  ) {
    return this.community.listNotifications(user.id, query);
  }

  @Post("notifications/read")
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  markNotificationsRead(@CurrentUser() user: User) {
    return this.community.markNotificationsRead(user.id);
  }

  @Post("reports")
  @UseGuards(JwtAuthGuard)
  report(
    @Body(new ZodValidationPipe(reportSchema)) body: any,
    @CurrentUser() user: User,
  ) {
    return this.community.report(user.id, body);
  }

  @Put("profile")
  @UseGuards(JwtAuthGuard)
  profile(
    @Body(new ZodValidationPipe(profileUpdateSchema)) body: any,
    @CurrentUser() user: User,
  ) {
    return this.community.updateProfile(user.id, body);
  }
}
