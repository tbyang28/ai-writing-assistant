import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { User } from '../db/schema';

export type AuthedRequest = Request & { user: User };

/** 从请求上取守卫挂载的当前用户 —— 对应 Python 的 current_user: User = Depends(get_current_user) */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    const request = ctx.switchToHttp().getRequest<AuthedRequest>();
    return request.user;
  },
);
