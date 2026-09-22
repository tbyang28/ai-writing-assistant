import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * zod 校验管道 —— 等价 FastAPI 的 pydantic 请求体校验。
 * 差异：FastAPI 校验失败返回 422，这里抛 400（全局过滤器会归一成 {"detail": ...}）。
 * 约束不得严于 pydantic 原版，避免出现「Python 放行、TS 拒绝」的契约漂移。
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new BadRequestException(first?.message ?? '请求参数不合法');
    }
    return result.data;
  }
}
