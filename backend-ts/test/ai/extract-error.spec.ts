import { describe, expect, it } from 'vitest';

import { extractAiError } from '../../src/ai/extract-error';
import { LlmHttpError } from '../../src/ai/llm/llm-client.interface';

describe('extractAiError', () => {
  it('余额不足关键词（body.message）→ 充值提示', () => {
    const e = new LlmHttpError(402, { message: 'Insufficient balance' }, '');
    expect(extractAiError(e)).toBe('SiliconFlow 账户余额不足，请充值后重试');
  });

  it('嵌套 error.message 里的中文「余额」也命中', () => {
    const e = new LlmHttpError(400, { error: { message: '账户余额不足' } }, '');
    expect(extractAiError(e)).toBe('SiliconFlow 账户余额不足，请充值后重试');
  });

  it('401/403 → API Key 提示', () => {
    expect(extractAiError(new LlmHttpError(401, { message: 'bad key' }, ''))).toBe(
      'SiliconFlow API Key 无效或没有权限，请检查 Render 后端环境变量 SILICONFLOW_API_KEY',
    );
    expect(extractAiError(new LlmHttpError(403, {}, ''))).toMatch(/^SiliconFlow API Key/);
  });

  it('其他上游错误 → 带状态码的 AI 服务错误', () => {
    const e = new LlmHttpError(500, { message: 'upstream boom' }, '');
    expect(extractAiError(e)).toBe('AI 服务错误 (500): upstream boom');
  });

  it('body.detail 优先于嵌套 error.message', () => {
    const e = new LlmHttpError(429, { detail: '限流了', error: { message: 'ignored' } }, '');
    expect(extractAiError(e)).toBe('AI 服务错误 (429): 限流了');
  });

  it('非 HTTP 错误（网络断/未配置 key）→ 通用失败文案', () => {
    expect(extractAiError(new Error('fetch failed'))).toBe('AI 服务调用失败: fetch failed');
    expect(extractAiError('字符串异常')).toBe('AI 服务调用失败: 字符串异常');
  });
});
