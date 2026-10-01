import { z } from "zod";

export const feedQuerySchema = z.object({
  sort: z.enum(["latest", "popular"]).default("latest"),
  genre: z.string().nullish(),
  tag: z.string().nullish(),
  q: z.string().nullish(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(30).default(12),
});

export const publishSchema = z.object({
  visibility: z.enum(["PUBLIC", "PRIVATE"]).default("PUBLIC"),
  status: z.enum(["SERIAL", "FINISHED"]).optional(),
  genre: z.string().max(40).nullish(),
  tags: z.array(z.string().max(24)).max(12).nullish(),
  allow_comments: z.boolean().optional(),
});

export const profileUpdateSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/),
  bio: z.string().max(300).default(""),
  avatar: z
    .union([
      z.literal(""),
      z
        .url()
        .refine(
          (value) => /^https?:\/\//i.test(value),
          "头像必须为 http/https URL",
        ),
    ])
    .optional(),
});

export const commentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "评论不能为空")
    .max(2000, "评论不能超过 2000 字"),
  parent_id: z.string().uuid().nullish(),
});

export const progressSchema = z.object({
  chapter_id: z.string().uuid(),
  position: z.coerce.number().int().min(0).max(2147483647).default(0),
});

export const reportSchema = z.object({
  target_type: z.enum(["BOOK", "COMMENT", "USER"]),
  target_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});

export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type PublishInput = z.infer<typeof publishSchema>;
export type CommentInput = z.infer<typeof commentSchema>;

export const searchQuerySchema = feedQuerySchema.extend({
  type: z.enum(["books", "users"]).default("books"),
  q: z.string().trim().max(200).default(""),
});
