import { describe, expect, it } from 'vitest';

import { AuthService, toUserResponse } from '../src/auth/auth.service';
import type { User } from '../src/db/schema';

/**
 * 认证服务单元测试 —— 对应 backend/tests/services/test_auth.py。
 * 重点：bcryptjs 能验证 Python bcrypt 产生的 $2b$ 哈希（数据迁移的前提）。
 */

// 由 Python 侧 bcrypt.gensalt()（cost 12）真实生成：
//   bcrypt.hashpw(b'demo-password-123', bcrypt.gensalt()).decode()
const PYTHON_BCRYPT_HASH =
  '$2b$12$1KRI9YCf2GsP.Edng7pZx.oJrftUS6.bNmv45XadfvwLN4qu8oCDq';

const fakeUser = (overrides: Partial<User> = {}): User =>
  ({
    id: '00000000-0000-0000-0000-000000000001',
    email: 'a@b.c',
    password: 'x',
    name: '作者',
    avatar: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as User;

describe('toUserResponse', () => {
  it('只暴露 id/email/name/avatar，不含密码哈希', () => {
    const res = toUserResponse(fakeUser());
    expect(res).toEqual({
      id: '00000000-0000-0000-0000-000000000001',
      email: 'a@b.c',
      name: '作者',
      avatar: '',
    });
    expect('password' in res).toBe(false);
  });
});

describe('密码哈希', () => {
  it('哈希后可验证，且 cost 为 10（TS 默认）', async () => {
    const service = authServiceStub();
    const hashed = await service.hashPassword('secret-pass');
    expect(hashed).toMatch(/^\$2[aby]\$10\$/);
    expect(await service.verifyPassword('secret-pass', hashed)).toBe(true);
    expect(await service.verifyPassword('wrong-pass', hashed)).toBe(false);
  });

  it('能验证 Python bcrypt 生成的 $2b$ 哈希（跨后端数据迁移前提）', async () => {
    const service = authServiceStub();
    expect(await service.verifyPassword('demo-password-123', PYTHON_BCRYPT_HASH)).toBe(true);
    expect(await service.verifyPassword('demo-password-124', PYTHON_BCRYPT_HASH)).toBe(false);
  });
});

describe('JWT', () => {
  it('payload 只含 sub 和 exp（与 Python 版一致，无 iat）', async () => {
    const service = authServiceStub();
    const token = await service.createAccessToken('user-uuid-123');
    const payload = await service.verifyAccessToken(token);
    expect(payload.sub).toBe('user-uuid-123');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeCloseTo(24 * 3600, -2);
    expect('iat' in payload).toBe(false);
  });

  it('签名被篡改或密钥不符时拒绝', async () => {
    const service = authServiceStub();
    const token = await service.createAccessToken('user-uuid-123');
    const tampered = token.slice(0, -3) + 'xyz';
    await expect(service.verifyAccessToken(tampered)).rejects.toThrow();
  });
});

/** 不连数据库的最小 service 桩（这两个方法只用 ConfigService + bcrypt） */
function authServiceStub() {
  const config = {
    getOrThrow: (key: string) =>
      key === 'SECRET_KEY' ? 'test-secret-key' : 1440,
    get: (key: string) => (key === 'ALGORITHM' ? 'HS256' : undefined),
  } as never;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AuthService(config, {} as any);
  return service;
}
