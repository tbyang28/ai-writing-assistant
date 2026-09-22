import { LlmHttpError } from './llm/llm-client.interface';

/**
 * 把 LLM 调用异常翻译成用户可读文案 —— 移植 routers/ai.py 的 _extract_ai_error：
 *   余额不足 → 充值提示；401/403 → API Key 提示；其余 → 带状态码的错误；
 *   非上游 HTTP 错误（网络/超时/未配置 key）→ 通用失败文案。
 */
export function extractAiError(e: unknown): string {
  if (e instanceof LlmHttpError) {
    try {
      const body = (e.body ?? {}) as Record<string, unknown>;
      const errorObj =
        body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : {};
      const msg = String(
        body.message ?? body.detail ?? errorObj.message ?? e.message ?? '',
      );
      if (msg.toLowerCase().includes('insufficient') || msg.includes('余额')) {
        return 'SiliconFlow 账户余额不足，请充值后重试';
      }
      if (e.status === 401 || e.status === 403) {
        return 'SiliconFlow API Key 无效或没有权限，请检查 Render 后端环境变量 SILICONFLOW_API_KEY';
      }
      return `AI 服务错误 (${e.status}): ${msg}`;
    } catch {
      // fallthrough
    }
  }
  return `AI 服务调用失败: ${e instanceof Error ? e.message : String(e)}`;
}
