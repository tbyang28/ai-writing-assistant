import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DRIZZLE, type Database } from '../db/drizzle.module';
import { localModelConnections, users, type LocalModelConnection } from '../db/schema';
import { isUuid } from '../shared/is-uuid';
import { LocalJobBroker } from './local-job-broker';
import { inventorySchema, localModelKey, parseLocalModel, type Inventory } from './protocol';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const LOCAL_ONLINE_MS = 30000;
export const LOCAL_PAIR_TTL_MS = 300000;

@Injectable()
export class LocalProvidersService {
  private readonly pairings = new Map<string, { ownerId: string; expiresAt: number }>();
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly jobs: LocalJobBroker) {}

  createPairing(ownerId: string) {
    for (const [key, entry] of this.pairings) if (entry.expiresAt <= Date.now() || entry.ownerId === ownerId) this.pairings.delete(key);
    if (this.pairings.size >= 1000) throw new ConflictException('配对服务繁忙，请稍后重试');
    const code = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + LOCAL_PAIR_TTL_MS;
    this.pairings.set(hash(code), { ownerId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  async pair(data: { code: string; name: string; inventory: Inventory }) {
    const key = hash(data.code);
    const pending = this.pairings.get(key);
    // 同步消费，避免两个同时到达的请求重复使用配对码。事务失败也必须重新生成码。
    this.pairings.delete(key);
    if (!pending || pending.expiresAt <= Date.now()) throw new BadRequestException('配对码无效或已过期，请在网页重新生成');
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    await this.db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, pending.ownerId)).for('update');
      if (!owner) throw new BadRequestException('账号已不可用');
      const existing = await tx.select({ id: localModelConnections.id }).from(localModelConnections)
        .where(eq(localModelConnections.ownerId, pending.ownerId));
      if (existing.length >= 5) throw new ConflictException('最多连接 5 台设备，请先撤销旧连接');
      await tx.insert(localModelConnections).values({ id, ownerId: pending.ownerId, name: data.name,
        tokenHash: hash(secret), inventory: JSON.stringify(data.inventory), enabled: false, lastSeenAt: new Date() });
    });
    return { connectionId: id, token: `${id}.${secret}` };
  }
  async authenticate(authorization?: string): Promise<LocalModelConnection> {
    const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(authorization ?? '');
    if (!match || !isUuid(match[1])) throw new UnauthorizedException('本机连接令牌无效');
    const [connection] = await this.db.select().from(localModelConnections).where(eq(localModelConnections.id, match[1]));
    if (!connection || !/^[a-f0-9]{64}$/.test(connection.tokenHash) || !timingSafeEqual(Buffer.from(connection.tokenHash, 'hex'), Buffer.from(hash(match[2]), 'hex'))) {
      throw new UnauthorizedException('本机连接令牌无效或已撤销');
    }
    return connection;
  }
  async list(ownerId: string) {
    const rows = await this.db.select().from(localModelConnections).where(eq(localModelConnections.ownerId, ownerId));
    return { connections: rows.map((row) => this.view(row)), runtimeVersion: 1 };
  }
  async update(ownerId: string, id: string, enabled: boolean) {
    const [row] = await this.db.update(localModelConnections).set({ enabled })
      .where(and(eq(localModelConnections.id, id), eq(localModelConnections.ownerId, ownerId))).returning();
    if (!row) throw new NotFoundException('连接不存在');
    if (!enabled) this.jobs.cancelConnection(id);
    return this.view(row);
  }
  async revoke(ownerId: string, id: string) {
    const [row] = await this.db.delete(localModelConnections)
      .where(and(eq(localModelConnections.id, id), eq(localModelConnections.ownerId, ownerId))).returning({ id: localModelConnections.id });
    if (!row) throw new NotFoundException('连接不存在');
    this.jobs.cancelConnection(id);
  }
  async poll(connection: LocalModelConnection, inventory?: Inventory) {
    const [row] = await this.db.update(localModelConnections).set({ lastSeenAt: new Date(),
      ...(inventory ? { inventory: JSON.stringify(inventory) } : {}) })
      .where(eq(localModelConnections.id, connection.id)).returning();
    if (!row) throw new UnauthorizedException('连接已撤销');
    return { job: row.enabled ? this.jobs.take(row.id) : null };
  }
  async resolve(ownerId: string | undefined, model?: string) {
    const target = parseLocalModel(model);
    if (!target) return null;
    if (!ownerId) throw new Error('本机模型缺少账号授权');
    const [connection] = await this.db.select().from(localModelConnections).where(and(
      eq(localModelConnections.id, target.connectionId), eq(localModelConnections.ownerId, ownerId)));
    if (!connection) throw new Error('本机模型连接不存在或无权使用');
    if (!connection.enabled) throw new Error('本机模型连接尚未启用，请在模型连接页确认');
    if (Date.now() - connection.lastSeenAt.getTime() > LOCAL_ONLINE_MS) throw new Error('本机连接器已离线，请在电脑上重新连接');
    const inventory = inventorySchema.parse(JSON.parse(connection.inventory));
    const provider = inventory.providers.find((p) => p.id === target.provider);
    const entry = provider?.models.find((m) => m.id === target.model);
    if (!entry) throw new Error('本机模型已不可用，请刷新模型列表');
    return { ...target, tools: entry.tools, contextWindow: entry.contextWindow ?? 8192 };
  }
  private view(row: LocalModelConnection) {
    const inventory = inventorySchema.parse(JSON.parse(row.inventory));
    return { id: row.id, name: row.name, enabled: row.enabled,
      online: Date.now() - row.lastSeenAt.getTime() <= LOCAL_ONLINE_MS, lastSeenAt: row.lastSeenAt.toISOString(),
      providers: inventory.providers.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m,
        model: localModelKey(row.id, p.id, m.id) })) })), detectedClis: inventory.detectedClis };
  }
}
