import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * 全局异常过滤器 —— 把所有错误统一成 FastAPI 的 {"detail": "..."} 形状。
 *
 * 对应 Python 侧两个机制：
 *   1. HTTPException(detail=...)           → {"detail": ...}
 *   2. main.py 的 global_exception_handler → 500 {"detail": "Internal server error: {exc}"}
 *
 * 注意：Nest 自带的校验错误形状是 {statusCode, message, error}，
 * 前端的错误 toast 只读 detail 字段，所以必须在这里归一。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json({ detail: normalizeDetail(body, exception) });
      return;
    }

    // 等价 Python 的 traceback.print_exc() + 泄漏 str(exc) 的行为（迁移期保持一致）
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    const message =
      exception instanceof Error ? exception.message : String(exception ?? '');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      detail: `Internal server error: ${message}`,
    });
  }
}

function normalizeDetail(body: string | object, exception: HttpException): string {
  if (typeof body === 'string') {
    return body;
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if ('detail' in record) {
      return String(record.detail);
    }
    // Nest 默认 BadRequest/ValidationException 形状：{statusCode, message, error}
    if ('message' in record) {
      const message = record.message;
      return Array.isArray(message) ? message.join(', ') : String(message);
    }
  }
  return exception.message;
}
