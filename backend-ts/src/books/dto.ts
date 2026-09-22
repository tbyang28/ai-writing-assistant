import { z } from 'zod';

/**
 * 请求体 schema —— 镜像 backend/app/schemas/book.py。
 * 约束不得严于 pydantic 原版（title 就是普通字符串，email 同理）。
 */

export const bookCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  cover: z.string().nullish(),
});

export const bookUpdateSchema = z.object({
  title: z.string().nullish(),
  description: z.string().nullish(),
  cover: z.string().nullish(),
  status: z.string().nullish(),
});

export const chapterCreateSchema = z.object({
  title: z.string().nullish(),
});

export const chapterUpdateSchema = z.object({
  title: z.string().nullish(),
  content: z.string().nullish(),
  status: z.string().nullish(),
});

export const chapterSaveSchema = z.object({
  chapter_id: z.string().min(1),
  title: z.string().nullish(),
  content: z.string().nullish(),
});

/** Python 版接收裸 dict：chapter_id 缺失 → 查不到行 → 404（而非校验 400） */
export const chapterPublishSchema = z.object({
  chapter_id: z.string().optional(),
});

export const outlineCreateSchema = z.object({
  title: z.string().min(1),
  content: z.string().nullish(),
});

export const characterCreateSchema = z.object({
  name: z.string().min(1),
  role: z.string().nullish(),
  bio: z.string().nullish(),
});

export const characterRelationCreateSchema = z.object({
  source_character_id: z.string().min(1),
  target_character_id: z.string().min(1),
  relation_type: z.string().default('ally'),
  description: z.string().nullish(),
  strength: z.coerce.number().int().default(2),
});

export const inspirationCreateSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).nullish(),
});

export type BookCreateInput = z.infer<typeof bookCreateSchema>;
export type BookUpdateInput = z.infer<typeof bookUpdateSchema>;
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;
export type ChapterUpdateInput = z.infer<typeof chapterUpdateSchema>;
export type ChapterSaveInput = z.infer<typeof chapterSaveSchema>;
