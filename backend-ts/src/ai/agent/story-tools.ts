import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../../db/drizzle.module';
import {
  chapters,
  characterRelations,
  characters,
  inspirations,
  outlines,
  type Book,
} from '../../db/schema';
import { RagService } from '../../rag/rag.service';
import { codePointLength, codePointSlice, pyJsonDumpsAsciiList } from '../../shared/text';
import type { LlmToolSpec } from '../llm/llm-client.interface';
import { buildTextDiff, summarizeDiff } from '../text-diff';

/** 单个工具结果的最大长度（防模型一次检索烧光上下文预算） */
const TOOL_RESULT_MAX_CHARS = 1500;
/** 每章喂给模型的尾部字数（近期剧情要点通常在章末） */
const CHAPTER_TAIL_CHARS = 600;
/** diff_edit 输入上限（字符）：diff 按码点切分，太长既费 token 又费 CPU */
const DIFF_INPUT_MAX_CHARS = 4000;

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
 *
 * 权限分层（面试常问点）：
 *   只读：search_story / get_characters / get_outline / get_recent_chapters / get_chapter
 *         list_chapters / get_character_relations / list_inspirations
 *   写：  save_inspiration / save_character —— 写草稿区与设定库（低危；save_character 按名查重）
 *   审阅：diff_edit —— 产出逐字差异报告但不落库，应用与否由用户决定
 * 高危写操作（改章节正文）刻意不做成工具：agent 只能提案，不能擅自改稿。
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
    {
      name: 'get_chapter',
      description: '获取某一章的完整正文（默认最新一章）。需要通读整章或在原文基础上改写时使用。',
      parameters: {
        type: 'object',
        properties: {
          order: { type: 'integer', description: '章节序号（1 起），缺省取最新一章' },
        },
      },
    },
    {
      name: 'save_inspiration',
      description:
        '把讨论中产生的好点子写入本书的灵感库（设定想法、桥段、金句等）。只有用户表达「记下来/存一下」一类意图时才调用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '灵感标题，缺省取内容前 20 字' },
          content: { type: 'string', description: '灵感内容' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签，如["设定","支线"]' },
        },
        required: ['content'],
      },
    },
    {
      name: 'diff_edit',
      description:
        '对一段正文给出修改稿并生成逐字差异报告（「将X改为Y」列表）。模型产出 revised 后调用本工具审阅改动量；不会改动存储的章节内容。',
      parameters: {
        type: 'object',
        properties: {
          original: { type: 'string', description: '待修改的原文片段' },
          revised: { type: 'string', description: '修改后的文本（必须与原文等位可比，不要重写整章）' },
        },
        required: ['original', 'revised'],
      },
    },
    {
      name: 'list_chapters',
      description: '列出章节目录（序号/标题/状态/字数，不含正文）。需要定位某章或了解全书结构时使用。',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_character_relations',
      description: '获取人物之间的关系网（关系类型/描述/强度）。检查人物互动是否矛盾时使用。',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'list_inspirations',
      description: '查看灵感库里已存的点子（最近的在前）。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '取最近几条，默认 10，最多 20' },
        },
      },
    },
    {
      name: 'save_character',
      description:
        '把一个讨论定稿的人物写入人物设定库。只有用户表达「存进人物库/记下来」一类意图时才调用；同名人物已存在时不会重复创建。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '人物名' },
          role: { type: 'string', description: '身份：主角/反派/师父/同伴/配角等' },
          bio: { type: 'string', description: '人物简介' },
        },
        required: ['name'],
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
        case 'get_chapter':
          return await this.getChapter(asOrderOrNull(args.order), book.id);
        case 'save_inspiration':
          return await this.saveInspiration(args, book.id);
        case 'diff_edit':
          return this.diffEdit(args);
        case 'list_chapters':
          return await this.listChapters(book.id);
        case 'get_character_relations':
          return await this.getCharacterRelations(book.id);
        case 'list_inspirations':
          return await this.listInspirations(clampInspirationLimit(args.limit), book.id);
        case 'save_character':
          return await this.saveCharacter(args, book.id);
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

  /** 读整章：默认最新一章，或按 order 序号取特定章 */
  private async getChapter(order: number | null, bookId: string): Promise<ToolExecResult> {
    const rows = order
      ? await this.db
          .select()
          .from(chapters)
          .where(and(eq(chapters.bookId, bookId), eq(chapters.order, order)))
          .limit(1)
      : await this.db
          .select()
          .from(chapters)
          .where(eq(chapters.bookId, bookId))
          .orderBy(desc(chapters.order))
          .limit(1);
    const chapter = rows[0];
    if (!chapter) {
      return { ok: true, content: order ? `（没有找到第 ${order} 章）` : '（尚无章节）' };
    }
    const text = (chapter.content ?? '').trim();
    const total = `共 ${codePointLength(text)} 字`;
    return {
      ok: true,
      content: `【${chapter.title}】（${total}）\n${codePointSlice(text, 0, 3000)}${
        codePointLength(text) > 3000 ? '\n（后文略，可用 search_story 定位具体情节）' : ''
      }`,
    };
  }

  /** 唯一的写工具：往灵感库插一行（tags 存 JSON 字符串，与设定库 API 契约一致） */
  private async saveInspiration(
    args: Record<string, unknown>,
    bookId: string,
  ): Promise<ToolExecResult> {
    const content = String(args.content ?? '').trim();
    if (!content) {
      return { ok: false, content: 'save_inspiration 需要非空的 content 参数。' };
    }
    const title = String(args.title ?? '').trim() || codePointSlice(content, 0, 20);
    const tags = asStringArray(args.tags) ?? [];
    const [row] = await this.db
      .insert(inspirations)
      .values({ title, content: codePointSlice(content, 0, 2000), tags: pyJsonDumpsAsciiList(tags), bookId })
      .returning({ id: inspirations.id });
    return { ok: true, content: `已存入灵感库：「${title}」（id: ${row.id}）` };
  }

  /** diff_edit 不落库：只产出审阅报告（改动清单 + 改动占比护栏），由用户决定是否应用 */
  private diffEdit(args: Record<string, unknown>): ToolExecResult {
    const original = codePointSlice(String(args.original ?? ''), 0, DIFF_INPUT_MAX_CHARS);
    const revised = codePointSlice(String(args.revised ?? ''), 0, DIFF_INPUT_MAX_CHARS + 1000);
    if (!original.trim() || !revised.trim()) {
      return { ok: false, content: 'diff_edit 需要非空的 original 与 revised 参数。' };
    }
    if (original === revised) {
      return { ok: true, content: '原文与修改稿完全相同，没有任何改动。' };
    }

    const segments = buildTextDiff(original, revised);
    const changedChars = segments
      .filter((s) => s.type !== 'equal')
      .reduce((sum, s) => sum + codePointLength(s.text), 0);
    const ratio = Math.round((changedChars / Math.max(codePointLength(original), 1)) * 100);

    const summary = summarizeDiff(segments);
    const lines = [`共 ${summary.length} 处修改（改动字符占比 ${ratio}%）：`];
    for (const [i, s] of summary.entries()) {
      lines.push(`${i + 1}. ${s}`);
    }
    if (ratio > 50) {
      lines.push('⚠️ 改动占比超过 50%，更接近重写而非修改；如目标是润色，请收敛。');
    }
    return { ok: true, content: codePointSlice(lines.join('\n'), 0, TOOL_RESULT_MAX_CHARS) };
  }

  /** 章节目录（不含正文）：给模型一张「全书结构地图」，配合 get_chapter 定位细读 */
  private async listChapters(bookId: string): Promise<ToolExecResult> {
    const rows = await this.db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .orderBy(asc(chapters.order))
      .limit(50);
    if (rows.length === 0) {
      return { ok: true, content: '（尚无章节）' };
    }
    const lines = rows.map(
      (c) => `- 第${c.order}章「${c.title}」 [${c.status}] ${c.wordCount}字`,
    );
    return { ok: true, content: codePointSlice(lines.join('\n'), 0, TOOL_RESULT_MAX_CHARS) };
  }

  /** 人物关系网：先取关系行，再用一次人物查询把 id 解析成名（避免 join 列名冲突） */
  private async getCharacterRelations(bookId: string): Promise<ToolExecResult> {
    const rows = await this.db
      .select()
      .from(characterRelations)
      .where(eq(characterRelations.bookId, bookId))
      .orderBy(asc(characterRelations.createdAt))
      .limit(30);
    if (rows.length === 0) {
      return { ok: true, content: '（尚未设定人物关系）' };
    }
    const chars = await this.db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(eq(characters.bookId, bookId));
    const nameOf = new Map(chars.map((c) => [c.id, c.name]));
    const lines = rows.map((r) => {
      const src = nameOf.get(r.sourceCharacterId) ?? '（已删除人物）';
      const dst = nameOf.get(r.targetCharacterId) ?? '（已删除人物）';
      const desc = r.description ? `：${codePointSlice(r.description, 0, 80)}` : '';
      return `- ${src} —${r.relationType}（强度${r.strength}/5）→ ${dst}${desc}`;
    });
    return { ok: true, content: codePointSlice(lines.join('\n'), 0, TOOL_RESULT_MAX_CHARS) };
  }

  /** 灵感库回读：save_inspiration 的对称读，让模型能引用之前存过的点子 */
  private async listInspirations(limit: number, bookId: string): Promise<ToolExecResult> {
    const rows = await this.db
      .select()
      .from(inspirations)
      .where(eq(inspirations.bookId, bookId))
      .orderBy(desc(inspirations.createdAt))
      .limit(limit);
    if (rows.length === 0) {
      return { ok: true, content: '（灵感库为空）' };
    }
    const lines = rows.map((i) => {
      const tags = safeParseTags(i.tags);
      const tagPart = tags.length > 0 ? ` [${tags.join('/')}]` : '';
      return `- ${i.title}${tagPart}：${codePointSlice(i.content, 0, 120)}`;
    });
    return { ok: true, content: codePointSlice(lines.join('\n'), 0, TOOL_RESULT_MAX_CHARS) };
  }

  /** 人物入库：按书名内名字查重，已存在则返回现状而不是制造重复行 */
  private async saveCharacter(
    args: Record<string, unknown>,
    bookId: string,
  ): Promise<ToolExecResult> {
    const name = String(args.name ?? '').trim();
    if (!name) {
      return { ok: false, content: 'save_character 需要非空的 name 参数。' };
    }
    const role = String(args.role ?? '').trim(); // 列是 notNull default ''，空串而非 null
    const bio = codePointSlice(String(args.bio ?? '').trim(), 0, 500);

    const existing = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.bookId, bookId), eq(characters.name, name)))
      .limit(1);
    if (existing[0]) {
      const c = existing[0];
      return {
        ok: true,
        content: `人物「${name}」已在设定库中（${c.role || '身份未设定'}${c.bio ? `：${c.bio}` : ''}），未重复创建。`,
      };
    }

    await this.db.insert(characters).values({ name, role, bio, bookId });
    return {
      ok: true,
      content: `已入库人物：${name}${role ? `（${role}）` : ''}${bio ? `：${codePointSlice(bio, 0, 100)}` : ''}`,
    };
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

/** order 参数：正整数取整，无效值视为「最新一章」 */
function asOrderOrNull(value: unknown): number | null {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
  return n !== null && n >= 1 ? n : null;
}

/** 灵感读取条数：默认 10，上限 20 */
function clampInspirationLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 10;
  return Math.min(Math.max(n, 1), 20);
}

/** tags 列是 JSON 字符串契约（可能含 \uXXXX 转义）；坏数据按无标签处理 */
function safeParseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
