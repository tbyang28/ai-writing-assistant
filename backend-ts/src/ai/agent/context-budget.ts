import { Buffer } from 'node:buffer';

import type { ChatMessage, LlmToolCall, LlmToolSpec } from '../llm/llm-client.interface';

export interface ContextBudgetOptions {
  contextWindow?: number;
  maxOutputTokens?: number;
  headroomTokens?: number;
}

export const DEFAULT_CONTEXT_BUDGET = Object.freeze({
  contextWindow: 32768,
  maxOutputTokens: 4096,
  headroomTokens: 1024,
});

export interface ContextTokenEstimate {
  estimatedTokens: number;
  messageTokens: number;
  toolSchemaTokens: number;
  estimationMethod: 'utf8-bytes-upper-bound';
}

export interface PreparedContext extends ContextTokenEstimate {
  messages: ChatMessage[];
  originalEstimatedTokens: number;
  inputBudget: number;
  contextWindow: number;
  maxOutputTokens: number;
  headroomTokens: number;
  prunedMessages: number;
  prunedTurns: number;
  deduplicatedToolResults: number;
  /** Zero-based positions in the input; useful for attaching provenance outside this module. */
  retainedMessageIndices: number[];
}

export class ContextBudgetError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED';

  constructor(
    readonly inputBudget: number,
    readonly minimumEstimatedTokens: number,
    readonly contextWindow: number,
    readonly maxOutputTokens: number,
    readonly headroomTokens: number,
  ) {
    super(`当前任务资料估算需要 ${minimumEstimatedTokens} tokens，超过可用输入预算 ${inputBudget}；请缩小待处理范围或减少背景资料后重试。`);
    this.name = 'ContextBudgetError';
  }
}

/**
 * Explicit read-only allowlist, independent of the runtime/tool service. Unknown tools and
 * diff_edit are deliberately not deduplicated. Keep this list aligned when integrating new tools.
 */
const READ_ONLY_TOOLS = new Set([
  'search_story', 'get_characters', 'get_outline', 'get_recent_chapters',
  'get_chapter', 'list_chapters', 'get_character_relations', 'list_inspirations',
]);

/**
 * Estimate, NOT a model tokenizer: charge one token per serialized UTF-8 byte, plus fixed
 * request (16), message (16), tool-call (16), and tool-schema (32) framing allowances.
 * This intentionally overestimates Chinese/emoji and ASCII for byte-based tokenizers, rather
 * than applying length/4. Provider-specific hidden formatting is not a guaranteed bound;
 * headroom reserves extra space. Schemas and call IDs/arguments are included in full.
 */
export function estimateContextTokens(
  messages: readonly ChatMessage[],
  tools: readonly LlmToolSpec[] = [],
): ContextTokenEstimate {
  const messageTokens = 16 + messages.reduce((total, message) => total +
    Buffer.byteLength(JSON.stringify(message), 'utf8') + 16 + (message.toolCalls?.length ?? 0) * 16, 0);
  const toolSchemaTokens = tools.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(
    tools.map((tool) => ({ type: 'function', function: tool })),
  ), 'utf8') + tools.length * 32;
  return {
    estimatedTokens: messageTokens + toolSchemaTokens,
    messageTokens,
    toolSchemaTokens,
    estimationMethod: 'utf8-bytes-upper-bound',
  };
}

/** Object key order/JSON whitespace are ignored; array order and string whitespace matter. */
function normalizedArguments(raw: string): string | undefined {
  const canonical = (value: unknown): string => {
    if (typeof value === 'number' && (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new TypeError('Unsafe JSON number');
    }
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return canonical(parsed);
  } catch {
    return undefined;
  }
}

/** Validate pairing before pruning so malformed input can never become a silently split unit. */
function pairedCalls(messages: readonly ChatMessage[]): Map<number, LlmToolCall> {
  const resultCalls = new Map<number, LlmToolCall>();
  const pending = new Map<string, LlmToolCall>();
  for (const [index, message] of messages.entries()) {
    // System instructions may occur anywhere; they are always kept.
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const call = message.toolCallId === undefined ? undefined : pending.get(message.toolCallId);
      if (!call || (message.toolName !== undefined && message.toolName !== call.name)) {
        throw new TypeError(`Invalid tool history at message ${index}: unmatched tool result.`);
      }
      pending.delete(call.id);
      resultCalls.set(index, call);
      continue;
    }
    if (pending.size > 0) throw new TypeError(`Invalid tool history at message ${index}: missing tool results.`);
    if (message.toolCalls?.length) {
      if (message.role !== 'assistant') throw new TypeError('Only assistant messages may contain tool calls.');
      for (const call of message.toolCalls) {
        if (!call.id || pending.has(call.id)) throw new TypeError('Invalid tool history: duplicate/empty call ID.');
        pending.set(call.id, call);
      }
    }
  }
  if (pending.size > 0) throw new TypeError('Invalid tool history: missing tool results.');
  return resultCalls;
}

interface Turn {
  indices: number[];
  protected: boolean;
}

function interactionTurns(messages: readonly ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') { latestUser = index; break; }
  }
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') continue;
    if (!current || message.role === 'user') {
      current = { indices: [], protected: latestUser < 0 || index >= latestUser };
      turns.push(current);
    }
    current.indices.push(index);
  }
  return turns;
}

function duplicateHint(retainedPosition: number): string {
  return `[Duplicate read-only result; identical content retained at message #${retainedPosition + 1} (1-based).]`;
}

/**
 * Keep the newest full result and replace older exact duplicates with bounded references.
 * Never deduplicate arbitrary assistant/user/system text: equal text is not proof of equal
 * provenance. Results must match the same allowlisted tool, normalized object arguments,
 * and byte-for-byte content. A user/system boundary or any non-read-only batch resets the
 * scope, including failed/unknown writes and mixed read/write batches.
 */
function duplicateReferences(messages: readonly ChatMessage[], calls: Map<number, LlmToolCall>): Map<number, number> {
  const references = new Map<number, number>();
  const groups: number[][] = [];
  let seen = new Map<string, number[]>();
  let readOnlyBatch = false;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user' || message.role === 'system') seen = new Map();
    if (message.role === 'assistant' && message.toolCalls?.length) {
      readOnlyBatch = message.toolCalls.every((call) => READ_ONLY_TOOLS.has(call.name));
      if (!readOnlyBatch) seen = new Map();
    }
    const call = calls.get(index);
    if (!call || !readOnlyBatch) continue;
    const args = normalizedArguments(call.argumentsJson);
    if (args === undefined) continue;
    const key = JSON.stringify([call.name, args, message.content]);
    const duplicates = seen.get(key) ?? [];
    // The hint uses a bounded numeric position rather than an untrusted/unbounded call ID.
    if (Buffer.byteLength(message.content, 'utf8') > Buffer.byteLength(duplicateHint(index), 'utf8')) {
      if (duplicates.length === 0) {
        groups.push(duplicates);
        seen.set(key, duplicates);
      }
      duplicates.push(index);
    }
  }
  for (const group of groups) {
    const newest = group[group.length - 1];
    for (const earlier of group.slice(0, -1)) references.set(earlier, newest);
  }
  return references;
}

/**
 * Pure per-request budgeting. Prune oldest complete user turns first, including all assistant
 * tool calls/results in each turn; keep EVERY system message and the latest user turn in full
 * (except safe duplicate tool-result hints). No body slicing or automatic summarization.
 * Automatic summaries and StoryMemory source-aware deduplication are future integration work:
 * ChatMessage alone has no source IDs, and identical prose is intentionally never deduplicated.
 */
export function prepareContext(
  messages: readonly ChatMessage[],
  tools: readonly LlmToolSpec[] = [],
  options: ContextBudgetOptions = {},
): PreparedContext {
  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_BUDGET.contextWindow;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_CONTEXT_BUDGET.maxOutputTokens;
  const headroomTokens = options.headroomTokens ?? DEFAULT_CONTEXT_BUDGET.headroomTokens;
  for (const [name, value] of Object.entries({ contextWindow, maxOutputTokens, headroomTokens })) {
    if (!Number.isSafeInteger(value) || value < (name === 'contextWindow' ? 1 : 0)) {
      throw new RangeError(`${name} must be a ${name === 'contextWindow' ? 'positive' : 'nonnegative'} safe integer.`);
    }
  }
  const inputBudget = contextWindow - maxOutputTokens - headroomTokens;
  const calls = pairedCalls(messages);
  const turns = interactionTurns(messages);
  const references = duplicateReferences(messages, calls);
  const retained = new Set(messages.map((_, index) => index));
  const originalEstimatedTokens = estimateContextTokens(messages, tools).estimatedTokens;

  const render = () => {
    const indices = [...retained];
    const positions = new Map(indices.map((index, position) => [index, position]));
    let deduplicatedToolResults = 0;
    const prepared = indices.map((index) => {
      const original = messages[index];
      const message = { ...original, ...(original.toolCalls ? {
        toolCalls: original.toolCalls.map((call) => ({ ...call })),
      } : {}) };
      const target = references.get(index);
      if (target !== undefined && positions.has(target)) {
        message.content = duplicateHint(positions.get(target)!);
        deduplicatedToolResults++;
      }
      return message;
    });
    return { messages: prepared, retainedMessageIndices: indices, deduplicatedToolResults,
      ...estimateContextTokens(prepared, tools) };
  };

  let prepared = render();
  let prunedTurns = 0;
  for (const turn of turns) {
    if (prepared.estimatedTokens <= inputBudget) break;
    if (turn.protected) continue;
    for (const index of turn.indices) retained.delete(index);
    prunedTurns++;
    prepared = render();
  }
  if (prepared.estimatedTokens > inputBudget) {
    throw new ContextBudgetError(inputBudget, prepared.estimatedTokens,
      contextWindow, maxOutputTokens, headroomTokens);
  }
  return { ...prepared, originalEstimatedTokens, inputBudget, contextWindow, maxOutputTokens,
    headroomTokens, prunedTurns, prunedMessages: messages.length - prepared.messages.length };
}
