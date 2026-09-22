import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import type { INestApplication } from '@nestjs/common';

import { buildTestApp } from './utils/app';
import { closeTestDb, query, truncateAll } from './utils/db';

/**
 * 认证接口 e2e —— 对应 backend/tests/routers/test_auth.py。
 * 状态码阶梯是契约核心：前端只在 401 时跳登录页（api/index.ts），
 * 所以 403（缺头）与 401（坏 token）的区分必须与 FastAPI 逐级一致。
 */

let app: INestApplication;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

beforeEach(async () => {
  await truncateAll();
});

async function registerUser(email = 'writer@example.com', password = 'secret-pass-1') {
  return request(app.getHttpServer()).post('/api/auth/register').send({
    email,
    password,
    name: '测试作者',
  });
}

describe('POST /api/auth/register', () => {
  it('注册成功返回 token 与用户（200）', async () => {
    const res = await registerUser();
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('bearer');
    expect(typeof res.body.access_token).toBe('string');
    expect(res.body.user).toMatchObject({
      email: 'writer@example.com',
      name: '测试作者',
      avatar: '',
    });
    expect(typeof res.body.user.id).toBe('string');
    expect('password' in res.body.user).toBe(false);
  });

  it('重复邮箱 → 400 {"detail":"邮箱已注册"}', async () => {
    await registerUser();
    const res = await registerUser();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ detail: '邮箱已注册' });
  });

  it('缺必填字段 → 400 且错误体是 {"detail": "..."}', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'x@y.z' });
    expect(res.status).toBe(400);
    expect(typeof res.body.detail).toBe('string');
  });

  it('密码超过 bcrypt 72 字节上限 → 400（Python 版此处会 500，TS 提前拦截）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'long@example.com', password: 'x'.repeat(80) });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('密码过长');
  });
});

describe('POST /api/auth/login', () => {
  it('正确凭据返回 token', async () => {
    await registerUser();
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'writer@example.com', password: 'secret-pass-1' });
    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
    expect(res.body.user.email).toBe('writer@example.com');
  });

  it('密码错误 → 401 邮箱或密码错误', async () => {
    await registerUser();
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'writer@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: '邮箱或密码错误' });
  });

  it('邮箱不存在 → 401 同样文案', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: '邮箱或密码错误' });
  });
});

describe('GET /api/auth/profile 的 403/401 阶梯', () => {
  it('无 Authorization 头 → 403 Not authenticated', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/profile');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ detail: 'Not authenticated' });
  });

  it('非 Bearer 方案 → 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set('Authorization', 'Basic abcdef');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ detail: 'Not authenticated' });
  });

  it('格式错的 token → 401 Invalid token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: 'Invalid token' });
  });

  it('过期 token → 401 Invalid token', async () => {
    const expired = await new SignJWT({ sub: '00000000-0000-0000-0000-000000000001' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode('test-secret-key'));
    const res = await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: 'Invalid token' });
  });

  it('token 有效但用户已删 → 401 User not found（前端会跳登录页）', async () => {
    const { body } = await registerUser();
    await query('DELETE FROM users WHERE id = $1', [body.user.id]);
    const res = await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set('Authorization', `Bearer ${body.access_token}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: 'User not found' });
  });

  it('有效 token → 200 返回当前用户', async () => {
    const { body } = await registerUser();
    const res = await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set('Authorization', `Bearer ${body.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'writer@example.com', name: '测试作者' });
  });
});
