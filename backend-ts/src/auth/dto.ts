import { z } from 'zod';

/**
 * 密码长度约束：bcrypt 算法只取前 72 字节，超长在 Python 版会直接 500，
 * 这里在 DTO 层拒绝（400），比崩溃好且不破坏任何已存在用户
 * （超长密码在旧版根本注册不成功）。
 */
const password = z
  .string()
  .min(1, '密码不能为空')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, '密码过长');

/** email 与 Python 版一致：普通字符串，不做格式校验 */
export const registerSchema = z.object({
  email: z.string().min(1, '邮箱不能为空'),
  password,
  name: z.string().nullish().transform((v) => v ?? null),
});

export const loginSchema = z.object({
  email: z.string().min(1, '邮箱不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
