import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { eq } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/drizzle.module';
import { users, type User } from '../db/schema';

/**
 * 认证服务 —— 对应 services/auth.py。
 * bcryptjs 兼容 Python bcrypt 产生的 $2b$ 哈希，迁移用户密码可原样验证。
 * JWT payload 与 Python 版严格一致：{ sub: userId, exp }（无 iat）。
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 10);
  }

  verifyPassword(plain: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(plain, hashed);
  }

  private secret(): Uint8Array {
    return new TextEncoder().encode(this.config.getOrThrow<string>('SECRET_KEY'));
  }

  async createAccessToken(userId: string): Promise<string> {
    const minutes = this.config.getOrThrow<number>('ACCESS_TOKEN_EXPIRE_MINUTES');
    return new SignJWT({ sub: userId })
      .setProtectedHeader({ alg: this.config.get<string>('ALGORITHM') ?? 'HS256' })
      .setExpirationTime(`${minutes}m`)
      .sign(this.secret());
  }

  /** 校验签名与 exp；失败抛错（由守卫翻译成 401 Invalid token） */
  async verifyAccessToken(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.secret(), {
      algorithms: [this.config.get<string>('ALGORITHM') ?? 'HS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('missing sub');
    }
    return payload;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0] ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async createUser(email: string, password: string, name: string | null): Promise<User> {
    const hashed = await this.hashPassword(password);
    const [user] = await this.db
      .insert(users)
      .values({ email, password: hashed, name: name ?? '' })
      .returning();
    return user;
  }
}

/** API 返回的用户形状（UserResponse：不含密码哈希） */
export function toUserResponse(user: User) {
  return { id: user.id, email: user.email, name: user.name, avatar: user.avatar };
}
