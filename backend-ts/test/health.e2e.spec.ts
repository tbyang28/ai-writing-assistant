import request from 'supertest';

import { buildTestApp } from './utils/app';

describe('health endpoints', () => {
  it('GET /api/health 返回运行状态（Render healthCheckPath）', async () => {
    const app = await buildTestApp();
    const res = await request(app.getHttpServer()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      message: 'AI Writing Platform Backend is running',
    });
    await app.close();
  });

  it('GET /health 别名可用（nginx 剥前缀场景）', async () => {
    const app = await buildTestApp();
    const res = await request(app.getHttpServer()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    await app.close();
  });

  it('GET / 返回根信息', async () => {
    const app = await buildTestApp();
    const res = await request(app.getHttpServer()).get('/');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('AI Writing Platform Backend is running');
    await app.close();
  });
});
