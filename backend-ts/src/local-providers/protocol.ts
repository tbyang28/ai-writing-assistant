import { z } from 'zod';
import { isUuid } from '../shared/is-uuid';

const text = (max: number) => z.string().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/u.test(s), '不能包含控制字符');
export const inventorySchema = z.object({
  providers: z.array(z.object({
    id: z.enum(['ollama', 'lmstudio']),
    models: z.array(z.object({ id: text(200), label: text(200), tools: z.boolean(),
      contextWindow: z.number().int().min(2048).max(1048576).optional(),
    }).strict()).max(20),
  }).strict()).max(2),
  detectedClis: z.array(z.enum(['claude', 'codex', 'copilot'])).max(3),
}).strict().refine((i) => new Set(i.providers.map((p) => p.id)).size === i.providers.length, '重复供应商')
  .refine((i) => i.providers.every((p) => new Set(p.models.map((m) => m.id)).size === p.models.length), '重复模型');
export type Inventory = z.infer<typeof inventorySchema>;
export const pairSchema = z.object({ version: z.literal(1), code: z.string().regex(/^[a-f0-9]{64}$/),
  name: text(60), inventory: inventorySchema }).strict();
export const pollSchema = z.object({ inventory: inventorySchema.optional() }).strict();
export const enableSchema = z.object({ enabled: z.boolean() }).strict();
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(), cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional() }).strict();
const callSchema = z.object({ id: text(200), name: text(100), argumentsJson: z.string().max(100000) }).strict();
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(16384) }).strict(),
  z.object({ type: z.literal('tool_call_delta'), index: z.number().int().min(0).max(31),
    id: z.string().max(200).optional(), name: z.string().max(100).optional(), arguments: z.string().max(16384).optional() }).strict(),
  z.object({ type: z.literal('done'), result: z.object({ answer: z.string().max(200000),
    toolCalls: z.array(callSchema).max(32).optional(),
    finishReason: z.enum(['stop', 'tool_calls', 'length', 'error', 'aborted', 'unknown']),
    rawFinishReason: z.string().max(100).optional(), usage: usageSchema.optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('failure'), message: z.string().max(200) }).strict(),
]);
export const eventRequestSchema = z.object({ seq: z.number().int().min(1).max(10000), event: eventSchema }).strict();
export type RuntimeEvent = z.infer<typeof eventSchema>;
export function localModelKey(connectionId: string, provider: string, modelId: string): string {
  return `local/${connectionId}/${provider}/${encodeURIComponent(modelId)}`;
}
export function parseLocalModel(key?: string) {
  if (!key?.startsWith('local/')) return null;
  const parts = /^local\/([a-f0-9-]{36})\/(ollama|lmstudio)\/([^/]{1,1200})$/.exec(key);
  if (!parts || !isUuid(parts[1])) throw new Error('本机模型标识无效，请重新选择模型');
  let model: string;
  try { model = decodeURIComponent(parts[3]); } catch { throw new Error('本机模型标识无效'); }
  return { connectionId: parts[1], provider: parts[2] as 'ollama' | 'lmstudio', model };
}
