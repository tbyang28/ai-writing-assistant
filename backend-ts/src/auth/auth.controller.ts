import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../core/current-user.decorator';
import { ZodValidationPipe } from '../core/zod-validation.pipe';
import { User } from '../db/schema';
import { AuthService, toUserResponse } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { loginSchema, registerSchema } from './dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 对应 routers/auth.py 的 register —— 注册即发 token（无重复注册校验竞态，与 Python 一致） */
  @Post('register')
  @HttpCode(200)
  async register(@Body(new ZodValidationPipe(registerSchema)) body: {
    email: string;
    password: string;
    name: string | null;
  }) {
    const existing = await this.auth.getUserByEmail(body.email);
    if (existing) {
      throw new BadRequestException('邮箱已注册');
    }
    const user = await this.auth.createUser(body.email, body.password, body.name);
    const token = await this.auth.createAccessToken(user.id);
    return { access_token: token, token_type: 'bearer', user: toUserResponse(user) };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodValidationPipe(loginSchema)) body: {
    email: string;
    password: string;
  }) {
    const user = await this.auth.getUserByEmail(body.email);
    // 与 Python 版一致的短路顺序（已知缺陷保留：无用户时不做哈希，存在时序侧信道）
    const ok = user && (await this.auth.verifyPassword(body.password, user.password));
    if (!ok) {
      throw new UnauthorizedException('邮箱或密码错误');
    }
    const token = await this.auth.createAccessToken((user as User).id);
    return { access_token: token, token_type: 'bearer', user: toUserResponse(user) };
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  getProfile(@CurrentUser() user: User) {
    return toUserResponse(user);
  }
}
