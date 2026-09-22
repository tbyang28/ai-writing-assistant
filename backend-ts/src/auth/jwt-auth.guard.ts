import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthedRequest } from '../core/current-user.decorator';

import { AuthService } from './auth.service';

/**
 * JWT 守卫 —— 对应 dependencies.py 的 get_current_user，但必须复刻
 * FastAPI HTTPBearer(auto_error=True) 的状态码阶梯（前端只对 401 跳登录页）：
 *
 *   缺失/格式错误的 Authorization 头 → 403 "Not authenticated"
 *   token 解不开 / 过期              → 401 "Invalid token"
 *   token 有效但用户已删             → 401 "User not found"
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      throw new HttpException('Not authenticated', 403);
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new HttpException('Not authenticated', 403);
    }

    let userId: string;
    try {
      const payload = await this.auth.verifyAccessToken(token);
      userId = payload.sub as string;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    const user = await this.auth.getUserById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    request.user = user;
    return true;
  }
}
