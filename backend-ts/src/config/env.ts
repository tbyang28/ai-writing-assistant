import { z } from 'zod';

/**
 * 环境变量校验 —— 镜像 backend/app/config.py 的 Settings。
 * 默认值与 Python 版逐项一致；DATABASE_URL/RUN_MIGRATIONS/PORT 为新增。
 */
const boolFromString = z
  .string()
  .default('true')
  .transform((v) => !['false', '0', 'no', ''].includes(v.toLowerCase()));

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8001),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@postgres:5432/ai_writing'),
  RUN_MIGRATIONS: boolFromString,
  SECRET_KEY: z.string().default('change-this-secret-key'),
  ALGORITHM: z.string().default('HS256'),
  ACCESS_TOKEN_EXPIRE_MINUTES: z.coerce.number().int().positive().default(1440),
  SILICONFLOW_API_KEY: z.string().default(''),
  SILICONFLOW_BASE_URL: z.string().default('https://api.siliconflow.cn/v1'),
  DEEPSEEK_MODEL: z.string().default('deepseek-ai/DeepSeek-V3.2'),
});

export type Env = z.infer<typeof envSchema>;

/** ConfigModule 的 validate 入口：解析失败直接在启动时抛错（等价 pydantic-settings fail-fast） */
export function validateEnv(raw: Record<string, unknown>): Env {
  return envSchema.parse(raw);
}
