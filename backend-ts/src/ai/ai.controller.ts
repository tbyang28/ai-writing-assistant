import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { and, eq } from 'drizzle-orm';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../core/current-user.decorator';
import { ZodValidationPipe } from '../core/zod-validation.pipe';
import { DRIZZLE, type Database } from '../db/drizzle.module';
import { books, type Book, type User } from '../db/schema';
import { codePointLength, codePointSlice } from '../shared/text';
import { parseCharacterExtraction } from './extraction';
import { extractAiError } from './extract-error';
import { LLM_CLIENT, type LlmClient } from './llm/llm-client.interface';
import {
  buildContinuePrompt,
  buildContextualChatPrompt,
  buildMessages,
} from './prompts';
import { POLISH_MEMORY_OPTIONS, StoryMemoryService } from './story-memory.service';
import { buildTextDiff, estimatePolishDiffMaxTokens, summarizeDiff } from './text-diff';
import {
  aiChatSchema,
  aiExtractCharactersSchema,
  aiOutlineSchema,
  aiPolishDiffSchema,
  aiWriteSchema,
  type AiChatInput,
  type AiExtractCharactersInput,
  type AiOutlineInput,
  type AiPolishDiffInput,
  type AiWriteInput,
} from './dto';

/**
 * AI 服务路由 —— 移植 routers/ai.py 全部 8 个端点。
 *
 * SSE 协议（字节级对齐）：
 *   chat/write 流:   token… → done → 字面量 data: [DONE]
 *   polish-diff 流:  meta → token… → result → done → [DONE]
 *   出错: in-band {"type":"error"} + [DONE]（HTTP 状态仍是 200）
 */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly memory: StoryMemoryService,
  ) {}

  // ===================== 非流式 =====================

  @Post('chat')
  @HttpCode(200)
  async chat(
    @Body(new ZodValidationPipe(aiChatSchema)) data: AiChatInput,
    @CurrentUser() user: User,
  ) {
    const book = await this.verifyBookAccess(data.book_id, user.id);
    try {
      const memoryQuery = data.current_content || data.message;
      const storyMemory = await this.memory.buildStoryMemory(
        book,
        memoryQuery,
        data.chapter_id ?? null,
        data.current_content ?? null,
      );
      const userMsg = buildContextualChatPrompt(data.message, storyMemory);
      const result = await this.llm.chat({
        messages: buildMessages('chat', userMsg, data.history ?? undefined),
        model: data.model ?? undefined,
      });
      return { data: result };
    } catch (e) {
      throw internalAiError(e);
    }
  }

  @Post('write')
  @HttpCode(200)
  async write(
    @Body(new ZodValidationPipe(aiWriteSchema)) data: AiWriteInput,
    @CurrentUser() user: User,
  ) {
    const book = await this.verifyBookAccess(data.book_id, user.id);
    try {
      const userMsg = await this.buildWritePrompt(data, book);
      const result = await this.llm.chat({
        messages: buildMessages(data.command, userMsg),
        model: data.model ?? undefined,
      });
      return { data: result };
    } catch (e) {
      throw internalAiError(e);
    }
  }

  @Post('polish-diff')
  @HttpCode(200)
  async polishDiff(
    @Body(new ZodValidationPipe(aiPolishDiffSchema)) data: AiPolishDiffInput,
    @CurrentUser() user: User,
  ) {
    const book = await this.verifyBookAccess(data.book_id, user.id);
    if (!(data.selected_text || data.content || '').trim()) {
      throw new BadRequestException('需要提供待润色文本');
    }
    try {
      const call = await this.preparePolishDiffCall(data, book);
      const result = await this.llm.chat({
        messages: call.messages,
        model: data.model ?? undefined,
        maxTokens: call.maxTokens,
        temperature: 0.35,
      });
      return { data: this.buildPolishDiffResponse(call, result.answer ?? '') };
    } catch (e) {
      throw internalAiError(e);
    }
  }

  @Post('extract-characters')
  @HttpCode(200)
  async extractCharacters(
    @Body(new ZodValidationPipe(aiExtractCharactersSchema)) data: AiExtractCharactersInput,
    @CurrentUser() user: User,
  ) {
    await this.verifyBookAccess(data.book_id, user.id);

    const content = (data.content || '').trim();
    if (codePointLength(content) < 20) {
      throw new BadRequestException('正文内容太短，无法识别人物');
    }
    try {
      const userMsg = `请从以下小说正文中识别人物：\n\n${codePointSlice(content, 0, 6000)}`;
      const result = await this.llm.chat({
        messages: buildMessages('extract_characters', userMsg),
        model: data.model ?? undefined,
      });
      try {
        return { data: { characters: parseCharacterExtraction(result.answer || '{}') } };
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new BadAiFormatException();
        }
        throw e;
      }
    } catch (e) {
      if (e instanceof BadAiFormatException) {
        throw e;
      }
      throw internalAiError(e);
    }
  }

  @Post('outline')
  @HttpCode(200)
  async outline(
    @Body(new ZodValidationPipe(aiOutlineSchema)) data: AiOutlineInput,
    @CurrentUser() user: User,
  ) {
    await this.verifyBookAccess(data.book_id, user.id);
    try {
      let userMsg = `小说标题：${data.title}\n`;
      if (data.genre) {
        userMsg += `题材：${data.genre}\n`;
      }
      userMsg += `章节数：${data.chapter_count}\n`;
      if (data.existing_outline) {
        userMsg += `现有大纲：${data.existing_outline}\n`;
      }
      userMsg += '\n请为我生成详细的小说大纲。';

      const result = await this.llm.chat({
        messages: buildMessages('outline', userMsg),
        model: data.model ?? undefined,
      });
      return { data: result };
    } catch (e) {
      // Python 版此端点的兜底文案没有 _extract_ai_error，直接拼 str(e)
      throw new HttpException(`AI 服务调用失败: ${errMsg(e)}`, 500);
    }
  }

  // ===================== 流式（SSE） =====================

  @Post('chat/stream')
  async chatStream(
    @Body(new ZodValidationPipe(aiChatSchema)) data: AiChatInput,
    @CurrentUser() user: User,
    @Res() res: Response,
  ) {
    const book = await this.verifyBookAccess(data.book_id, user.id);
    this.startSse(res);
    try {
      const memoryQuery = data.current_content || data.message;
      const storyMemory = await this.memory.buildStoryMemory(
        book,
        memoryQuery,
        data.chapter_id ?? null,
        data.current_content ?? null,
      );
      const userMsg = buildContextualChatPrompt(data.message, storyMemory);
      const messages = buildMessages('chat', userMsg, data.history ?? undefined);

      for await (const chunk of this.llm.chatStream({ messages, model: data.model ?? undefined })) {
        this.writeToken(res, chunk);
      }
      this.finishSse(res);
    } catch (e) {
      this.errorSse(res, e);
    }
    res.end();
  }

  @Post('write/stream')
  async writeStream(
    @Body(new ZodValidationPipe(aiWriteSchema)) data: AiWriteInput,
    @CurrentUser() user: User,
    @Res() res: Response,
  ) {
    const book = await this.verifyBookAccess(data.book_id, user.id);
    this.startSse(res);
    try {
      const userMsg = await this.buildWritePrompt(data, book);
      const messages = buildMessages(data.command, userMsg);

      for await (const chunk of this.llm.chatStream({ messages, model: data.model ?? undefined })) {
        this.writeToken(res, chunk);
      }
      this.finishSse(res);
    } catch (e) {
      this.errorSse(res, e);
    }
    res.end();
  }

  @Post('polish-diff/stream')
  async polishDiffStream(
    @Body(new ZodValidationPipe(aiPolishDiffSchema)) data: AiPolishDiffInput,
    @CurrentUser() user: User,
    @Res() res: Response,
  ) {
    const book = await this.verifyBookAccess(data.book_id, user.id);
    if (!(data.selected_text || data.content || '').trim()) {
      throw new BadRequestException('需要提供待润色文本');
    }
    this.startSse(res);
    try {
      const call = await this.preparePolishDiffCall(data, book);
      this.writeSse(res, {
        type: 'meta',
        data: {
          original: call.originalForAi,
          instruction: call.instruction,
          truncated: call.originalTail.length > 0,
          original_length: call.originalLength,
          processed_length: call.processedLength,
        },
      });

      const revisedChunks: string[] = [];
      for await (const chunk of this.llm.chatStream({
        messages: call.messages,
        model: data.model ?? undefined,
        maxTokens: call.maxTokens,
        temperature: 0.35,
      })) {
        revisedChunks.push(chunk);
        this.writeToken(res, chunk);
      }

      this.writeSse(res, {
        type: 'result',
        data: this.buildPolishDiffResponse(call, revisedChunks.join('')),
      });
      this.finishSse(res);
    } catch (e) {
      this.errorSse(res, e);
    }
    res.end();
  }

  // ===================== 共享逻辑 =====================

  /** 书籍归属校验 —— 对应 verify_book_access（非 UUID 直接 404，对齐 Python 查空行为） */
  private async verifyBookAccess(bookId: string, userId: string): Promise<Book> {
    if (!isUuid(bookId)) {
      throw new NotFoundException('作品不存在');
    }
    const rows = await this.db
      .select()
      .from(books)
      .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundException('作品不存在');
    }
    return rows[0];
  }

  /** write/write/stream 的 prompt 分派（continue 带作品记忆，其余是短模板） */
  private async buildWritePrompt(data: AiWriteInput, book: Book): Promise<string> {
    const command = data.command;
    const content = data.selected_text || data.content;

    if (command === 'continue') {
      const storyMemory = await this.memory.buildStoryMemory(
        book,
        content,
        data.chapter_id ?? null,
        data.content,
      );
      return buildContinuePrompt(content, storyMemory);
    }
    if (command === 'improve') {
      return `请润色以下文本：\n\n${codePointSlice(content, 0, 3000)}`;
    }
    if (command === 'fix') {
      return `请校对以下文本，修正错别字和语病：\n\n${codePointSlice(content, 0, 3000)}`;
    }
    if (command === 'summarize') {
      return `请概括以下内容：\n\n${codePointSlice(content, 0, 3000)}`;
    }
    return codePointSlice(content, 0, 3000);
  }

  /** polish-diff 的调用准备（截断、指令、消息、预算）—— _prepare_polish_diff_call */
  private async preparePolishDiffCall(data: AiPolishDiffInput, book: Book) {
    const original = (data.selected_text || data.content || '').trim();

    const originalForAi = codePointSlice(original, 0, 3000);
    const originalTail = codePointSlice(original, 3000);
    const instruction = (
      data.instruction || '在保留原意和剧情的基础上，让文字更自然、更有画面感。'
    ).trim();
    const storyMemory = await this.memory.buildStoryMemory(
      book,
      originalForAi,
      data.chapter_id ?? null,
      data.content,
      {
        ...POLISH_MEMORY_OPTIONS,
        currentChars: data.selected_text ? 800 : 0,
      },
    );
    const userMsg =
      `${storyMemory}\n\n` +
      '【AI 修改审阅任务】\n' +
      '请根据用户要求修改待处理文本，只修改必要之处。只输出修改后的正文，不要解释、不要标题、不要列修改点。\n' +
      '必须保留原文核心情节、人物关系、叙事视角和上下文一致性；不要新增与作品记忆冲突的设定。\n\n' +
      `【用户修改要求】\n${instruction}\n\n` +
      `【待处理文本】\n${originalForAi}`;

    return {
      messages: buildMessages('polish_diff', userMsg),
      instruction,
      originalForAi,
      originalTail,
      originalLength: codePointLength(original),
      processedLength: codePointLength(originalForAi),
      maxTokens: estimatePolishDiffMaxTokens(originalForAi),
    };
  }

  /** diff 响应组装 —— _build_polish_diff_response */
  private buildPolishDiffResponse(
    call: Awaited<ReturnType<AiController['preparePolishDiffCall']>>,
    revisedForAiRaw: string,
  ) {
    const revisedForAi = revisedForAiRaw.trim();
    const revised = revisedForAi + call.originalTail;
    const segments = buildTextDiff(call.originalForAi, revisedForAi);

    return {
      original: call.originalForAi,
      revised,
      segments,
      summary: summarizeDiff(segments),
      instruction: call.instruction,
      truncated: call.originalTail.length > 0,
      original_length: call.originalLength,
      processed_length: call.processedLength,
    };
  }

  // ===================== SSE 基础设施 =====================

  private startSse(res: Response): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  private writeSse(res: Response, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private writeToken(res: Response, text: string): void {
    this.writeSse(res, { type: 'token', data: { text } });
  }

  private finishSse(res: Response): void {
    this.writeSse(res, { type: 'done', data: {} });
    res.write('data: [DONE]\n\n');
  }

  private errorSse(res: Response, e: unknown): void {
    this.writeSse(res, { type: 'error', data: { message: extractAiError(e) } });
    res.write('data: [DONE]\n\n');
  }
}

/** JSON 解析失败 → 502（对齐 Python 的 JSONDecodeError 分支） */
class BadAiFormatException extends HttpException {
  constructor() {
    super('AI 返回格式无法解析，请重试', 502);
  }
}

function internalAiError(e: unknown): HttpException {
  return new HttpException(extractAiError(e), 500);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
