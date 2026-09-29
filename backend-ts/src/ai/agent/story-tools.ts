import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../../db/drizzle.module';
import { chapters, characters, outlines, type Book } from '../../db/schema';
import { RagService } from '../../rag/rag.service';
import { codePointSlice } from '../../shared/text';
import type { LlmToolSpec } from '../llm/llm-client.interface';

/** 单个工具结果的最大长度（防模型一次检索烧光上下文预算） */
const TOOL_RESULT_MAX_CHARS = 1500;
/** 每章喂给模型的尾部字数（近期剧情要点通常在章末） */
const CHAPTER_TAIL_CHARS = 600;

export interface ToolExecResult {
  ok: boolean;
  content: string;
}

/**
 * 写作 Agent 的工具箱 —— 把「作品数据」暴露成模型可主动调用的工具。
 *
 * 与 story-memory 的区别：旧模式是后端替模型决定把所有设定一次性塞进 prompt；
 * 这里只给模型最小的书籍信息，由它自己判断还需要什么、调工具来取。
 * 所有工具严格按 bookId 隔离（归属校验在 controller 层已完成）。
 */
@Injectable()
export class StoryToolsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly rag: RagService,
  ) {}

  /** 工具规格（OpenAI 兼容 function calling 格式，喂给 LLM 的 tools 字段） */
  readonly specs: LlmToolSpec[] = [
    {
      name: 'search_story',
      description:
        '按语义检索本书前文章节内容片段。当需要回忆某个情节、人物过往经历或设定细节时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索内容，用自然语言描述要找的情节或设定' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_characters',
      description: '获取本书的人物设定列表（身份、简介）。可按名字过滤。',
      parameters: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: '可选，只要查询的人物名列表',
          },
        },
      },
    },
    {
      name: 'get_outline',
      description: '获取本书的大纲与设定条目。',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_recent_chapters',
      description: '获取最近几章的正文尾部（最近的剧情进展）。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '取最近几章，默认 2，最多 5' },
        },
      },
    },
  ];

  /** 工具分发：未知工具与执行异常都不抛出——返回 ok:false 的文本喂回模型让它自行消化 */
  async execute(name: string, args: Record<string, unknown>, book: Book): Promise<ToolExecResult> {
    try {
      switch (name) {
        case 'search_story':
          return await this.searchStory(String(args.query ?? ''), book.id);
        case 'get_characters':
          return await this.getCharacters(asStringArray(args.names), book.id);
        case 'get_outline':
          return await this.getOutline(book.id);
        case 'get_recent_chapters':
          return await this.getRecentChapters(clampLimit(args.limit), book.id);
        default:
          return { ok: false, content: `未知工具：${name}。可用工具见系统说明。` };
      }
    } catch (e) {
      return { ok: false, content: `工具执行失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async searchStory(query: string, bookId: string): Promise<ToolExecResult> {
    const q = query.trim();
    if (!q) {
      return { ok: false, content: 'search_story 需要非空的 query 参数。' };
    }
    const results = await this.rag.searchSimilar(codePointSlice(q, 0, 500), bookId, 3);
    if (results.length === 0) {
      return { ok: true, content: '（未检索到相关前文片段）' };
    }
    const lines = results.map(
      (r, i) => `[片段${i + 1}·相关度${r.score}]\n${codePointSlice(r.content, 0, 400)}`,
    );
    return { ok: true, content: codePointSlice(lines.join('\n\n'), 0, TOOL_RESULT_MAX_CHARS) };
  }

  private async getCharacters(names: string[] | null, bookId: string): Promise<ToolExecResult> {
    const conditions = [eq(characters.bookId, bookId)];
    if (names && names.length > 0) {
      conditions.push(inArray(characters.name, names.slice(0, 10)));
    }
    const rows = await this.db
      .select()
      .from(characters)
      .where(and(...conditions))
      .orderBy(asc(characters.name))
      .limit(20);
    if (rows.length === 0) {
      return { ok: true, content: '（人物设定库为空）' };
    }
    const lines = rows.map((c) => {
      const role = c.role ? `（${c.role}）` : '';
      const bio = c.bio ? `：${codePointSlice(c.bio, 0, 150)}` : '';
      return `- ${c.name}${role}${bio}`;
    });
    return { ok: true, content: codePointSlice(lines.join('\n'), 0, TOOL_RESULT_MAX_CHARS) };
  }

  private async getOutline(bookId: string): Promise<ToolExecResult> {
    const rows = await this.db
      .select()
      .from(outlines)
      .where(eq(outlines.bookId, bookId))
      .orderBy(asc(outlines.order))
      .limit(12);
    if (rows.length === 0) {
      return { ok: true, content: '（尚无大纲）' };
    }
    const lines = rows.map((o) =>
      o.content ? `- ${o.title}：${codePointSlice(o.content, 0, 200)}` : `- ${o.title}`,
    );
    return { ok: true, content: codePointSlice(lines.join('\n'), 0, TOOL_RESULT_MAX_CHARS) };
  }

  private async getRecentChapters(limit: number, bookId: string): Promise<ToolExecResult> {
    const rows = await this.db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .orderBy(desc(chapters.order))
      .limit(limit);
    const withContent = rows.filter((c) => (c.content ?? '').trim());
    if (withContent.length === 0) {
      return { ok: true, content: '（尚无章节正文）' };
    }
    const blocks = withContent.map((c) => {
      const text = c.content.trim();
      const tail = codePointSlice(text, -CHAPTER_TAIL_CHARS);
      return `【${c.title}】（结尾节选）\n${tail}`;
    });
    return { ok: true, content: codePointSlice(blocks.join('\n\n'), 0, TOOL_RESULT_MAX_CHARS) };
  }
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const names = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return names.length > 0 ? names : null;
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 2;
  return Math.min(Math.max(n, 1), 5);
}
