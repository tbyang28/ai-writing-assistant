import { Injectable, NotFoundException, type PipeTransform } from '@nestjs/common';

/**
 * 路径参数 UUID 校验 —— 行为对齐 Python：
 * FastAPI 的 book_id 是裸 str，非 UUID 串查不到行 → 404 作品不存在。
 * Postgres 遇到非法 uuid 字面量会直接报错（→500），所以必须在管道层
 * 提前转成同样的 404，而不是用 Nest 默认的 ParseUUIDPipe（400 + 英文文案）。
 */
@Injectable()
export class ParseUuidOr404Pipe implements PipeTransform<string, string> {
  constructor(private readonly notFoundMessage: string) {}

  transform(value: string): string {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ) {
      throw new NotFoundException(this.notFoundMessage);
    }
    return value;
  }
}
