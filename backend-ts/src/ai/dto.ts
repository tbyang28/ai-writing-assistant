import { z } from 'zod';

/** 镜像 backend/app/schemas/ai.py（email/title 等都是普通字符串，不加严校验） */

const modelField = z.string().nullish(); // SiliconFlow model ID，null = 默认模型

export const aiChatSchema = z.object({
  book_id: z.string().min(1),
  message: z.string(),
  chapter_id: z.string().nullish(),
  current_content: z.string().nullish(),
  history: z
    .array(z.object({ role: z.string(), content: z.string() }))
    .nullish(),
  model: modelField,
});

export const aiWriteSchema = z.object({
  book_id: z.string().min(1),
  content: z.string(),
  command: z.string(), // continue | improve | fix | summarize | 其他
  chapter_id: z.string().nullish(),
  selected_text: z.string().nullish(),
  model: modelField,
});

export const aiOutlineSchema = z.object({
  book_id: z.string().min(1),
  title: z.string(),
  genre: z.string().nullish(),
  chapter_count: z.coerce.number().int().default(5),
  existing_outline: z.string().nullish(),
  model: modelField,
});

export const aiPolishDiffSchema = z.object({
  book_id: z.string().min(1),
  content: z.string(),
  chapter_id: z.string().nullish(),
  selected_text: z.string().nullish(),
  instruction: z.string().nullish(),
  model: modelField,
});

export const aiExtractCharactersSchema = z.object({
  book_id: z.string().min(1),
  content: z.string(),
  chapter_id: z.string().nullish(),
  model: modelField,
});

export type AiChatInput = z.infer<typeof aiChatSchema>;
export type AiWriteInput = z.infer<typeof aiWriteSchema>;
export type AiOutlineInput = z.infer<typeof aiOutlineSchema>;
export type AiPolishDiffInput = z.infer<typeof aiPolishDiffSchema>;
export type AiExtractCharactersInput = z.infer<typeof aiExtractCharactersSchema>;
