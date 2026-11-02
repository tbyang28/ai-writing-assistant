import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  ContextBudgetError,
  DEFAULT_CONTEXT_BUDGET,
  estimateContextTokens,
  prepareContext,
} from '../../src/ai/agent/context-budget';
import type { ChatMessage, LlmToolSpec } from '../../src/ai/llm/llm-client.interface';

const system: ChatMessage = { role: 'system', content: '只输出小说正文，不得改写设定。' };
const draft: ChatMessage = { role: 'user', content: `请续写当前正文：\n${'少年沿着山路追赶夜色。'.repeat(80)}\n最后一句不能丢。` };
const longResult = '主角张三与师父居住青云山，尚未取得灵剑。'.repeat(30);
const outlineTool: LlmToolSpec = {
  name: 'get_outline', description: '读作品大纲', parameters: { type: 'object', properties: {} },
};
const budget = (contextWindow: number) => ({ contextWindow, maxOutputTokens: 0, headroomTokens: 0 });

function exchange(id: string, name = 'get_outline', argumentsJson = '{}', content = longResult): ChatMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name, argumentsJson }] },
    { role: 'tool', toolCallId: id, toolName: name, content },
  ];
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function expectPairs(messages: ChatMessage[]) {
  let pending: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      expect(pending).toContain(message.toolCallId);
      pending = pending.filter((id) => id !== message.toolCallId);
    } else {
      expect(pending).toEqual([]);
      pending = message.toolCalls?.map((call) => call.id) ?? [];
    }
  }
  expect(pending).toEqual([]);
}

describe('独立上下文预算', () => {
  it('默认预留输出和 headroom，返回可观测估算与裁剪统计', () => {
    const messages = [system, draft];
    const result = prepareContext(messages);
    expect(DEFAULT_CONTEXT_BUDGET).toEqual({ contextWindow: 32768, maxOutputTokens: 4096, headroomTokens: 1024 });
    expect(result).toMatchObject({
      ...DEFAULT_CONTEXT_BUDGET, inputBudget: 27648, prunedMessages: 0, prunedTurns: 0,
      deduplicatedToolResults: 0, estimationMethod: 'utf8-bytes-upper-bound', retainedMessageIndices: [0, 1],
    });
    expect(result.messages).toEqual(messages);
    expect(result.estimatedTokens).toBe(result.originalEstimatedTokens);
    expect(result.estimatedTokens).toBe(result.messageTokens + result.toolSchemaTokens);
  });

  it('中文、emoji 与转义字符串按 UTF-8 字节保守估算，计入消息结构', () => {
    const content = '中文🙂\n"\\'.repeat(100);
    const estimate = estimateContextTokens([{ role: 'user', content }]);
    expect(estimate.messageTokens).toBeGreaterThan(Buffer.byteLength(content, 'utf8'));
    expect(estimate.messageTokens).toBeGreaterThan(content.length / 4 * 5);
    expect(estimate.toolSchemaTokens).toBe(0);
    expect(estimateContextTokens([{ role: 'user', content: '中'.repeat(100) }]).estimatedTokens -
      estimateContextTokens([{ role: 'user', content: 'a'.repeat(100) }]).estimatedTokens).toBe(200);
  });

  it('工具 schema 完整计入，较大 schema 会触发历史裁剪或最小上下文拒绝', () => {
    const largeTool: LlmToolSpec = { ...outlineTool,
      parameters: { type: 'object', properties: { text: { type: 'string', description: '详细参数说明。'.repeat(150) } } },
    };
    const messages = [system, { role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧答案'.repeat(800) }, draft];
    const window = estimateContextTokens([system, draft], [largeTool]).estimatedTokens;
    const result = prepareContext(messages, [largeTool], budget(window));
    expect(result.messages).toEqual([system, draft]);
    expect(result.toolSchemaTokens).toBeGreaterThan(Buffer.byteLength(JSON.stringify(largeTool)));
    expect(result.estimatedTokens).toBe(window);
    expect(() => prepareContext([system, draft], [largeTool], budget(window - 1))).toThrow(ContextBudgetError);
    expect(() => prepareContext([system, draft], [], budget(window - 1))).not.toThrow();
  });

  it('长历史优先移除最旧完整轮次，保留较新轮次和全部正文', () => {
    const history: ChatMessage[] = Array.from({ length: 70 }, (_, index) => [
      { role: 'user', content: `历史问题 ${index}：${'旧情节'.repeat(60)}` },
      { role: 'assistant', content: `历史回答 ${index}：${'旧答案'.repeat(80)}` },
    ]).flat();
    const messages = [system, ...history, draft];
    const expected = [system, ...history.slice(-4), draft];
    const result = prepareContext(messages, [], budget(estimateContextTokens(expected).estimatedTokens));
    expect(result.messages).toEqual(expected);
    expect(result.prunedTurns).toBe(68);
    expect(result.prunedMessages).toBe(136);
    expect(result.retainedMessageIndices).toEqual([0, 137, 138, 139, 140, 141]);
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.inputBudget);
    expect(result.messages.at(-1)?.content).toBe(draft.content);
  });

  it('旧轮次中的并行工具调用、全部结果和最后回答必须整体保留或删除', () => {
    const old: ChatMessage[] = [
      { role: 'user', content: '查大纲和人物' },
      { role: 'assistant', content: '先查资料', toolCalls: [
        { id: 'outline', name: 'get_outline', argumentsJson: '{}' },
        { id: 'characters', name: 'get_characters', argumentsJson: '{}' },
      ] },
      { role: 'tool', toolCallId: 'characters', toolName: 'get_characters', content: longResult },
      { role: 'tool', toolCallId: 'outline', toolName: 'get_outline', content: longResult },
      { role: 'assistant', content: '已查到。' },
    ];
    const messages = [system, ...old, draft];
    const all = prepareContext(messages);
    expect(all.messages).toEqual(messages);
    expectPairs(all.messages);
    const reduced = prepareContext(messages, [], budget(estimateContextTokens(messages).estimatedTokens - 1));
    expect(reduced.messages).toEqual([system, draft]);
    expect(reduced.prunedMessages).toBe(old.length);
    expectPairs(reduced.messages);
  });

  it('system 可穿插历史与工具结果之间，裁剪不能删除 system', () => {
    const extra: ChatMessage = { role: 'system', content: '追加约束：不得出现现代武器。' };
    const [call, result] = exchange('read');
    const messages = [system, { role: 'user', content: '旧任务' }, call, extra, result, draft];
    const prepared = prepareContext(messages, [], budget(estimateContextTokens([system, extra, draft]).estimatedTokens));
    expect(prepared.messages).toEqual([system, extra, draft]);
    expect(prepared.prunedMessages).toBe(3);
  });

  it('最新 user 含当前正文及后续工具轮次受保护，超限时不能丢正文或单独丢工具结果', () => {
    const messages = [system, draft, ...exchange('current')];
    const estimate = estimateContextTokens(messages).estimatedTokens;
    expect(() => prepareContext(messages, [], budget(estimate - 1))).toThrow(ContextBudgetError);
    expect(prepareContext(messages, [], budget(estimate)).messages).toEqual(messages);
  });

  it('最小保护内容超限抛带 code 与预算信息的 ContextBudgetError，不静默截断', () => {
    const messages = [system, { role: 'user', content: '可删历史' }, { role: 'assistant', content: '历史回答' }, draft];
    const minimum = estimateContextTokens([system, draft]).estimatedTokens;
    try {
      prepareContext(messages, [], { contextWindow: minimum + 29, maxOutputTokens: 20, headroomTokens: 10 });
      throw new Error('Expected budget rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextBudgetError);
      expect(error).toMatchObject({ name: 'ContextBudgetError', code: 'CONTEXT_BUDGET_EXCEEDED',
        inputBudget: minimum - 1, minimumEstimatedTokens: minimum, contextWindow: minimum + 29,
        maxOutputTokens: 20, headroomTokens: 10 });
    }
    expect(messages.at(-1)?.content).toBe(draft.content);
  });

  it('输出和 headroom 已耗尽小窗口时明确拒绝；没有 user 时保守保护全部消息', () => {
    expect(() => prepareContext([draft], [], { contextWindow: 100 })).toThrow(ContextBudgetError);
    const messages = [system, { role: 'assistant', content: longResult }];
    expect(() => prepareContext(messages, [], budget(100))).toThrow(ContextBudgetError);
  });

  it.each([
    { contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: Infinity },
    { maxOutputTokens: -1 }, { maxOutputTokens: 1.5 }, { headroomTokens: NaN },
    { headroomTokens: Number.MAX_SAFE_INTEGER + 1 },
  ])('非法预算在使用前拒绝：%j', (options) => {
    expect(() => prepareContext([draft], [], options)).toThrow(RangeError);
  });

  it('仅重复只读工具同参数同结果去重；保留全部调用与结果配对，旧结果指向最新完整结果', () => {
    const messages = [system, draft,
      ...exchange('a', 'get_outline', '{"filter":{"b":2,"a":1},"n":1}'),
      ...exchange('b', 'get_outline', ' { "n": 1, "filter": { "a": 1, "b": 2 } } '),
      ...exchange('c', 'get_outline', '{"n":1,"filter":{"a":1,"b":2}}'),
    ];
    const result = prepareContext(messages);
    expect(result.deduplicatedToolResults).toBe(2);
    expect(result.messages[3].content).toContain('message #8 (1-based)');
    expect(result.messages[5].content).toBe(result.messages[3].content);
    expect(result.messages[7].content).toBe(longResult);
    expect(result.messages[3].content.length).toBeLessThan(128);
    expect(result.estimatedTokens).toBeLessThan(result.originalEstimatedTokens);
    expect(result.prunedMessages).toBe(0);
    expectPairs(result.messages);
    // Exact fitting proves duplicate savings are used before considering removal/rejection.
    expect(prepareContext(messages, [], budget(result.estimatedTokens)).messages).toEqual(result.messages);
  });

  it.each([
    ['不同工具', 'get_characters', '{}', longResult],
    ['不同参数', 'get_outline', '{"n":2}', longResult],
    ['数组顺序不同', 'get_outline', '{"names":["乙","甲"]}', longResult],
    ['结果仅差空白', 'get_outline', '{"names":["甲","乙"]}', `${longResult} `],
  ])('%s 不能被当成重复结果', (_label, name, args, content) => {
    const messages = [draft, ...exchange('a', 'get_outline', '{"names":["甲","乙"]}'),
      ...exchange('b', name, args, content)];
    expect(prepareContext(messages).deduplicatedToolResults).toBe(0);
  });

  it.each(['{坏 JSON', 'null', '[]', '{"n":9007199254740993}', '{"n":1e309}'])('无法安全规范化参数时不去重：%s', (args) => {
    expect(prepareContext([draft, ...exchange('a', 'get_outline', args),
      ...exchange('b', 'get_outline', args)]).deduplicatedToolResults).toBe(0);
  });

  it.each(['save_character', 'save_inspiration', 'diff_edit', 'unknown_tool'])('跨 %s 调用不去重，即使写入结果表明失败', (name) => {
    const messages = [draft, ...exchange('before'), ...exchange('barrier', name, '{}', '{"ok":false}'),
      ...exchange('after'), ...exchange('after-again')];
    const result = prepareContext(messages);
    expect(result.deduplicatedToolResults).toBe(1);
    expect(result.messages[2].content).toBe(longResult);
    expect(result.messages.at(-1)?.content).toBe(longResult);
  });

  it('同一批中夹有写工具时，读结果也不参与跨写入去重', () => {
    const messages: ChatMessage[] = [draft, ...exchange('before'),
      { role: 'assistant', content: '', toolCalls: [
        { id: 'mixed-read', name: 'get_outline', argumentsJson: '{}' },
        { id: 'mixed-write', name: 'save_character', argumentsJson: '{}' },
      ] },
      { role: 'tool', toolCallId: 'mixed-read', content: longResult },
      { role: 'tool', toolCallId: 'mixed-write', content: '已写入' }, ...exchange('after'),
    ];
    expect(prepareContext(messages).deduplicatedToolResults).toBe(0);
  });

  it.each(['user', 'system'])('跨 %s 边界不去重，避免外部数据变更或指令变化', (role) => {
    const messages = [draft, ...exchange('before'), { role, content: '现在再读' }, ...exchange('after')];
    expect(prepareContext(messages).deduplicatedToolResults).toBe(0);
  });

  it('短结果不替换成更长提示；重复普通文本也不擅自去重或声称来源去重', () => {
    const repeated = [system, { ...system }, draft, { role: 'assistant', content: draft.content },
      ...exchange('a', 'get_outline', '{}', '无'), ...exchange('b', 'get_outline', '{}', '无')];
    const result = prepareContext(repeated);
    expect(result.messages).toEqual(repeated);
    expect(result.deduplicatedToolResults).toBe(0);
  });

  it('裁剪后重算提示中的消息序号，保留结果仍在输出中且配对完整', () => {
    const messages = [system, { role: 'user', content: longResult }, { role: 'assistant', content: longResult },
      draft, ...exchange('a'), ...exchange('b')];
    const minimal = prepareContext([system, draft, ...exchange('a'), ...exchange('b')]);
    const result = prepareContext(messages, [], budget(minimal.estimatedTokens));
    expect(result.messages).toEqual(minimal.messages);
    expect(result.messages[3].content).toContain('message #6 (1-based)');
    expect(result.messages[5].content).toBe(longResult);
    expectPairs(result.messages);
  });

  it.each([
    [{ role: 'tool', toolCallId: 'orphan', content: '孤立结果' }],
    [exchange('a')[0]],
    [exchange('a')[0], { role: 'user', content: '缺少结果' }],
    [exchange('a')[0], { role: 'tool', toolCallId: 'a', toolName: 'wrong', content: '错名结果' }],
  ] as ChatMessage[][])('不以裁剪掩盖坏工具历史：%j', (...messages) => {
    expect(() => prepareContext(messages, [], budget(1))).toThrow(/Invalid tool history/);
  });

  it('不修改输入消息、调用、schema 或 options；输出中的嵌套调用也独立', () => {
    const messages = freezeDeep([system, draft, ...exchange('a'), ...exchange('b')]);
    const tools = freezeDeep([outlineTool]);
    const options = freezeDeep({ contextWindow: 32768 });
    const before = JSON.stringify({ messages, tools, options });
    const result = prepareContext(messages, tools, options);
    result.messages[2].toolCalls![0].argumentsJson = '{"changed":true}';
    result.messages[1].content = '修改返回值';
    expect(JSON.stringify({ messages, tools, options })).toBe(before);
    expect(prepareContext(messages, tools, options).messages[1].content).toBe(draft.content);
  });
});
