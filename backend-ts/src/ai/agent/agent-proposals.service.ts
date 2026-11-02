import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { toCharacterResponse, toInspirationResponse } from '../../books/mappers';
import { DRIZZLE, type Database } from '../../db/drizzle.module';
import {
  agentProposals, books, characters, inspirations,
  type AgentProposal, type Book,
} from '../../db/schema';
import { isUuid } from '../../shared/is-uuid';
import { codePointLength, codePointSlice, pyJsonDumpsAsciiList } from '../../shared/text';

/** 固定 20 分钟。过期只限制首次提交，已成功确认的重试始终返回原结果。 */
export const AGENT_PROPOSAL_TTL_MS = 20 * 60 * 1000;

const boundedText = (max: number) => z.string().trim()
  .refine((value) => codePointLength(value) <= max, `最多允许 ${max} 字`)
  .refine((value) => !value.includes('\u0000'), '文本不能包含空字符');
const nonemptyText = (max: number) => boundedText(max).refine((value) => value.length > 0, '不能为空');
const characterArgs = z.object({
  name: nonemptyText(100),
  role: boundedText(100).default(''),
  bio: boundedText(500).default(''),
}).strict();
const inspirationArgs = z.object({
  title: boundedText(200).optional(),
  content: nonemptyText(2000),
  tags: z.array(nonemptyText(50)).max(20).default([]),
}).strict();

export const proposalDigestSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ProposalTool = 'save_character' | 'save_inspiration';
export type ProposalArgs = z.infer<typeof characterArgs> | (z.infer<typeof inspirationArgs> & { title: string });
export type ProposalStatus = 'pending' | 'confirmed' | 'cancelled';
export type ProposalResult =
  | { id: string; tool: 'save_character'; created: boolean; character: ReturnType<typeof toCharacterResponse> }
  | { id: string; tool: 'save_inspiration'; created: true;
      inspiration: Omit<ReturnType<typeof toInspirationResponse>, 'created_at'> & { created_at: string } };
export interface ProposalView {
  id: string;
  bookId: string;
  tool: ProposalTool;
  args: ProposalArgs;
  digest: string;
  expiresAt: string;
  status: ProposalStatus;
}
export type ConfirmedProposal = ProposalView & { status: 'confirmed'; result: ProposalResult };
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** 独立于模型工具执行器；只有 JWT controller 可代表用户确认，createProposal 永不写设定库。 */
@Injectable()
export class AgentProposalsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Runtime 接线入口；保留 createProposal 作为语义明确的兼容入口。 */
  create(book: Pick<Book, 'id' | 'ownerId'>, tool: string, args: unknown, signal?: AbortSignal): Promise<ProposalView> {
    return this.createProposal(book, tool, args, signal);
  }

  async createProposal(
    book: Pick<Book, 'id' | 'ownerId'>,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ProposalView> {
    signal?.throwIfAborted();
    const validated = validateArgs(tool, args);
    if (!isUuid(book.id) || !isUuid(book.ownerId)) {
      throw new NotFoundException('作品不存在');
    }
    return this.db.transaction(async (tx) => {
      // 与 confirm/cancel 保持相同的锁顺序：book -> proposal，避免与删书级联死锁。
      const [owned] = await tx.select().from(books)
        .where(and(eq(books.id, book.id), eq(books.ownerId, book.ownerId))).for('update');
      if (!owned) throw new NotFoundException('作品不存在');
      signal?.throwIfAborted();
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + AGENT_PROPOSAL_TTL_MS);
      const digest = digestOf({ id, bookId: owned.id, ownerId: owned.ownerId, ...validated, expiresAt });
      const [proposal] = await tx.insert(agentProposals).values({
        id, bookId: owned.id, ownerId: owned.ownerId, tool: validated.tool,
        args: JSON.stringify(validated.args), digest, expiresAt,
      }).returning();
      signal?.throwIfAborted(); // 事务提交前最后一个检查；提交成功后不再报告取消。
      return toView(proposal, validated);
    });
  }

  async confirm(id: string, userId: string, digest: string, signal?: AbortSignal): Promise<ConfirmedProposal> {
    signal?.throwIfAborted();
    validateDigest(digest);
    return this.db.transaction(async (tx) => {
      const proposal = await this.lockOwnedProposal(tx, id, userId);
      const validated = validateStoredProposal(proposal, digest);
      if (proposal.status === 'confirmed') {
        // result 存成 API JSON 快照，重复确认（包括过期后的重试）得到同一真实对象 id。
        return { ...toView(proposal, validated), status: 'confirmed', result: JSON.parse(proposal.result!) as ProposalResult };
      }
      if (proposal.status !== 'pending') throw new ConflictException('提案已取消');
      await assertNotExpired(tx, proposal.id);
      signal?.throwIfAborted();

      let result: ProposalResult;
      if (validated.tool === 'save_character') {
        const args = validated.args as z.infer<typeof characterArgs>;
        // book 行锁串行化本服务的同名查重，不给历史人物表添加名称唯一约束。
        const [existing] = await tx.select().from(characters)
          .where(and(eq(characters.bookId, proposal.bookId), eq(characters.name, args.name)))
          .orderBy(asc(characters.createdAt), asc(characters.id)).limit(1);
        const character = existing ?? (await tx.insert(characters)
          .values({ bookId: proposal.bookId, name: args.name, role: args.role, bio: args.bio }).returning())[0];
        result = { id: character.id, tool: 'save_character', created: !existing, character: toCharacterResponse(character) };
      } else {
        const args = validated.args as z.infer<typeof inspirationArgs> & { title: string };
        const [inspiration] = await tx.insert(inspirations).values({
          bookId: proposal.bookId, title: args.title, content: args.content,
          tags: pyJsonDumpsAsciiList(args.tags),
        }).returning();
        // Date -> ISO，首次返回值和持久化 JSON 的幂等重试返回值完全一致。
        result = {
          id: inspiration.id, tool: 'save_inspiration', created: true,
          inspiration: { ...toInspirationResponse(inspiration), created_at: inspiration.createdAt.toISOString() },
        };
      }
      const [confirmed] = await tx.update(agentProposals)
        .set({ status: 'confirmed', result: JSON.stringify(result) })
        .where(eq(agentProposals.id, id)).returning();
      await assertNotExpired(tx, proposal.id);
      signal?.throwIfAborted();
      return { ...toView(confirmed, validated), status: 'confirmed', result };
    });
  }

  async cancel(id: string, userId: string, digest: string, signal?: AbortSignal): Promise<ProposalView> {
    signal?.throwIfAborted();
    validateDigest(digest);
    return this.db.transaction(async (tx) => {
      const proposal = await this.lockOwnedProposal(tx, id, userId);
      const validated = validateStoredProposal(proposal, digest);
      if (proposal.status === 'confirmed') throw new ConflictException('提案已确认');
      if (proposal.status === 'cancelled') return toView(proposal, validated);
      await assertNotExpired(tx, proposal.id);
      const [cancelled] = await tx.update(agentProposals).set({ status: 'cancelled' })
        .where(eq(agentProposals.id, id)).returning();
      signal?.throwIfAborted();
      return toView(cancelled, validated);
    });
  }

  private async lockOwnedProposal(tx: Transaction, id: string, userId: string): Promise<AgentProposal> {
    if (!isUuid(id) || !isUuid(userId)) throw new NotFoundException('提案不存在');
    const [hint] = await tx.select({ bookId: agentProposals.bookId }).from(agentProposals)
      .where(and(eq(agentProposals.id, id), eq(agentProposals.ownerId, userId)));
    if (!hint) throw new NotFoundException('提案不存在');
    const [book] = await tx.select({ id: books.id }).from(books)
      .where(and(eq(books.id, hint.bookId), eq(books.ownerId, userId))).for('update');
    if (!book) throw new NotFoundException('提案不存在');
    const [proposal] = await tx.select().from(agentProposals)
      .where(and(eq(agentProposals.id, id), eq(agentProposals.bookId, book.id), eq(agentProposals.ownerId, userId)))
      .for('update');
    if (!proposal) throw new NotFoundException('提案不存在');
    return proposal;
  }
}

function validateArgs(tool: string, args: unknown): { tool: ProposalTool; args: ProposalArgs } {
  if (tool === 'save_character') {
    const parsed = characterArgs.safeParse(args);
    if (parsed.success) return { tool, args: parsed.data };
  } else if (tool === 'save_inspiration') {
    const parsed = inspirationArgs.safeParse(args);
    if (parsed.success) return { tool, args: {
      title: parsed.data.title || codePointSlice(parsed.data.content, 0, 20),
      content: parsed.data.content, tags: parsed.data.tags,
    } };
  } else {
    throw new BadRequestException('不支持的提案工具');
  }
  throw new BadRequestException('提案参数不合法或超出长度限制');
}

function validateDigest(digest: unknown): asserts digest is string {
  if (!proposalDigestSchema.safeParse({ digest }).success) throw new BadRequestException('提案摘要不合法');
}

function digestOf(proposal: {
  id: string; bookId: string; ownerId: string; tool: string; args: ProposalArgs; expiresAt: Date;
}): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1, id: proposal.id, bookId: proposal.bookId, ownerId: proposal.ownerId,
    tool: proposal.tool, args: proposal.args, expiresAt: proposal.expiresAt.toISOString(),
  })).digest('hex');
}

function validateStoredProposal(proposal: AgentProposal, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(proposal.digest) ||
      !timingSafeEqual(Buffer.from(proposal.digest, 'hex'), Buffer.from(digest, 'hex'))) {
    throw new ConflictException('提案摘要不匹配');
  }
  let validated: ReturnType<typeof validateArgs>;
  try {
    validated = validateArgs(proposal.tool, JSON.parse(proposal.args));
  } catch {
    throw new ConflictException('提案内容已变更');
  }
  if (digestOf({ ...proposal, ...validated }) !== proposal.digest) {
    throw new ConflictException('提案内容已变更');
  }
  return validated;
}

async function assertNotExpired(tx: Transaction, id: string): Promise<void> {
  // 单独在所有行锁获取后查询数据库时钟，避免事务起始时间/等待锁期间导致过期检查失真。
  const [row] = await tx.select({ expired: sql<boolean>`${agentProposals.expiresAt} <= clock_timestamp()` })
    .from(agentProposals).where(eq(agentProposals.id, id));
  if (row.expired) throw new GoneException('提案已过期');
}

function toView(proposal: AgentProposal, validated: ReturnType<typeof validateArgs>): ProposalView {
  return {
    id: proposal.id, bookId: proposal.bookId, tool: validated.tool, args: validated.args,
    digest: proposal.digest, expiresAt: proposal.expiresAt.toISOString(), status: proposal.status as ProposalStatus,
  };
}
