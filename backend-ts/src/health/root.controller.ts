import { Controller, Get } from '@nestjs/common';

/**
 * 根/健康端点 —— 三个路径都必须排除在 /api 全局前缀之外：
 *   GET /            → Python main.py 的 root()
 *   GET /health      → health_alias()（给 docker/nginx healthcheck 的别名，
 *                      历史原因是本地 nginx 剥 /api 前缀的坑）
 *   GET /api/health  → health()（Render render.yaml 的 healthCheckPath）
 *
 * Nest 的 exclude 按「未加前缀的路由路径」匹配：@Get('api/health') + exclude('api/health')
 * 是让这个路径不变成 /api/api/health 的唯一写法。
 */
@Controller()
export class RootController {
  @Get()
  root() {
    return {
      status: 'ok',
      message: 'AI Writing Platform Backend is running',
      health: '/api/health',
    };
  }

  @Get('health')
  healthAlias() {
    return this.health();
  }

  @Get('api/health')
  health() {
    return { status: 'ok', message: 'AI Writing Platform Backend is running' };
  }
}
