import { describe, expect, it } from 'vitest';
import evaluationCases from '../../eval/scenes/cases.json';

import {
  applySceneRepairs, parseSceneJson, repairSchema, reviewSchema, sceneConstraints,
  scenePlanSchema, validateFindings, type SceneConstraint, type SceneFinding, type ScenePlan,
} from '../../src/ai/scene/scene-contract';
import { rankSceneOutlines } from '../../src/ai/story-memory.service';

const plan: ScenePlan = { goal: '拿到钥匙', withheld: '不揭露身世', pov: '沈川有限视角', ending: '停在门外', targetChars: 800 };
const constraints: SceneConstraint[] = [...sceneConstraints(plan),
  { id: 'source:character', text: '沈川不会游泳', authoritative: true },
  { id: 'source:outline', text: '未来计划渡河', authoritative: false },
  { id: 'source:chapter', text: '老人声称门后有人', authoritative: false },
  { id: 'source:draft', text: '当前草稿末尾', authoritative: false },
];
type RawFinding = Parameters<typeof validateFindings>[0]['findings'][number];
const finding = (overrides: Partial<RawFinding> = {}): RawFinding => ({
  kind: 'pov', constraintId: 'pov', quote: '他知道守卫在想什么',
  reason: '超出视角人物的知识范围', suggestion: '改为可观察的动作', ...overrides,
});
function grounded(draft: string, items: RawFinding[]) {
  return validateFindings(reviewSchema.parse({ findings: items }), draft, constraints);
}
function repairs(draft: string, selected: SceneFinding[], edits: Array<{ id: string; replacement: string }>) {
  return applySceneRepairs(draft, selected, repairSchema.parse({ edits }));
}

describe('fixed synthetic scene evaluation contracts', () => {
  it.each(evaluationCases)('$id has a valid confirmed plan', ({ plan }) => {
    expect(scenePlanSchema.parse(plan)).toEqual(plan);
  });
});

describe('scene structured JSON', () => {
  it.each(['plain', 'fenced'])('accepts one complete %s JSON document', (format) => {
    const json = JSON.stringify(plan);
    expect(parseSceneJson(format === 'fenced' ? `\n\`\`\`json\n${json}\n\`\`\`\n` : json, scenePlanSchema)).toEqual(plan);
  });

  it.each([
    'not JSON', '{}', 'null', '[]', '{"goal":"x"',
    `说明：${JSON.stringify(plan)}`, `${JSON.stringify(plan)}\n附注`,
    JSON.stringify({ ...plan, targetChars: 199 }), JSON.stringify({ ...plan, targetChars: 1601 }),
    JSON.stringify({ ...plan, targetChars: 800.5 }), JSON.stringify({ ...plan, goal: '  ' }),
    JSON.stringify({ ...plan, extra: true }),
  ])('rejects malformed or incomplete plans without scraping embedded braces: %s', (raw) => {
    expect(() => parseSceneJson(raw, scenePlanSchema)).toThrow('未生成可应用结果');
  });

  it('rejects model-supplied severity, source authority, and edit offsets', () => {
    for (const extra of [{ severity: 'conflict' }, { authoritative: true }, { source: 'canon' }, { start: 0 }]) {
      expect(() => parseSceneJson(JSON.stringify({ findings: [{ ...finding(), ...extra }] }), reviewSchema)).toThrow('未生成可应用结果');
    }
    expect(() => parseSceneJson('{"edits":[{"id":"finding-1","replacement":"x","start":0}]}', repairSchema)).toThrow();
  });
});

describe('scene finding grounding', () => {
  it('uses an exact, unique quote and UTF-16 offsets including emoji', () => {
    const draft = '🌧️门前。\n他知道守卫在想什么。风声仍在。';
    const { findings, dropped } = grounded(draft, [finding()]);
    expect(dropped).toBe(0);
    expect(findings).toEqual([{ ...finding(), id: 'finding-1', severity: 'conflict', constraint: plan.pov,
      start: draft.indexOf(finding().quote), end: draft.indexOf(finding().quote) + finding().quote.length, repairable: true }]);
    expect(draft.slice(findings[0].start, findings[0].end)).toBe(finding().quote);
  });

  it.each([
    ['goal', 'goal', 'suggestion', false], ['goal', 'ending', 'suggestion', false],
    ['revelation', 'withheld', 'conflict', true], ['pov', 'pov', 'conflict', true],
    ['style', 'style', 'suggestion', false], ['continuity', 'source:character', 'conflict', true],
    ['continuity', 'source:outline', 'suggestion', true], ['continuity', 'source:chapter', 'suggestion', true],
    ['continuity', 'source:draft', 'suggestion', true],
  ] as const)('grounds %s against %s and derives severity from that source', (kind, constraintId, severity, repairable) => {
    const result = grounded('唯一证据', [finding({ kind, constraintId, quote: '唯一证据' })]);
    expect(result.dropped).toBe(0);
    expect(result.findings[0]).toMatchObject({ severity, repairable, constraintId });
  });

  it.each([
    ['goal', 'pov'], ['revelation', 'goal'], ['pov', 'withheld'], ['style', 'source:character'],
    ['continuity', 'goal'], ['continuity', 'source:invented'], ['revelation', 'missing'],
  ] as const)('drops incompatible or invented constraint references: %s/%s', (kind, constraintId) => {
    expect(grounded('唯一证据', [finding({ kind, constraintId, quote: '唯一证据' })])).toEqual({ findings: [], dropped: 1 });
  });

  it.each([
    ['回头。回头。', '回头'], ['aaaa', 'aa'], ['原文只有门响。', '原文没有的证据'],
    ['门响。', '门 响'], ['门响。', '门响!'],
  ])('drops ambiguous, overlapping repetitions, invented, or inexact evidence in %s', (draft, quote) => {
    expect(grounded(draft, [finding({ quote })])).toEqual({ findings: [], dropped: 1 });
  });

  it('drops overlapping findings and numbers only accepted findings; adjacent quotes remain valid', () => {
    const result = grounded('甲乙丙丁戊', [
      finding({ quote: '不存在' }), finding({ quote: '甲乙丙' }),
      finding({ quote: '乙丙丁' }), finding({ quote: '丁戊' }), finding({ quote: '甲乙丙' }),
    ]);
    expect(result.dropped).toBe(3);
    expect(result.findings.map(f => ({ id: f.id, start: f.start, end: f.end }))).toEqual([
      { id: 'finding-1', start: 0, end: 3 }, { id: 'finding-2', start: 3, end: 5 },
    ]);
  });

  it('omits empty optional constraints so fabricated withheld/ending references cannot be grounded', () => {
    const minimal = sceneConstraints({ ...plan, withheld: '', ending: '' });
    expect(minimal.map(c => c.id)).toEqual(['goal', 'pov', 'style']);
    expect(validateFindings({ findings: [finding({ kind: 'revelation', constraintId: 'withheld', quote: '证据' })] }, '证据', minimal).dropped).toBe(1);
  });
});

describe('scene bounded repairs', () => {
  const draft = '🌧️门前\n他知道守卫在想什么。\n门轴发出细响。\n结尾保持原样。';
  const selected = grounded(draft, [finding(), finding({ kind: 'continuity', constraintId: 'source:chapter', quote: '门轴发出细响' })]).findings;

  it('applies out-of-order edits at original offsets and preserves all other prose byte for byte', () => {
    const result = repairs(draft, selected, [
      { id: selected[1].id, replacement: '门轴没有动静' }, { id: selected[0].id, replacement: '他看见守卫皱起眉' },
    ]);
    expect(result).toBe('🌧️门前\n他看见守卫皱起眉。\n门轴没有动静。\n结尾保持原样。');
    expect(draft).toContain('他知道守卫在想什么');
  });

  it('allows skipping every edit or deleting a short reviewed quote', () => {
    expect(repairs(draft, selected, [])).toBe(draft);
    expect(repairs(draft, selected, [{ id: selected[0].id, replacement: '' }])).toBe(draft.replace(selected[0].quote, ''));
  });

  it.each(['unknown', 'duplicate', 'unrepairable', 'stale', 'overlap'])('rejects %s edits atomically', (mode) => {
    let allowed = selected.map(f => ({ ...f }));
    let edits = [{ id: selected[0].id, replacement: '有效替换' }];
    if (mode === 'unknown') edits.push({ id: 'invented-id', replacement: 'x' });
    if (mode === 'duplicate') edits.push({ ...edits[0] });
    if (mode === 'unrepairable') allowed[0].repairable = false;
    if (mode === 'stale') allowed[0].quote = '与初稿不符';
    if (mode === 'overlap') {
      allowed[1] = { ...allowed[1], start: allowed[0].start + 1, end: allowed[0].end,
        quote: draft.slice(allowed[0].start + 1, allowed[0].end) };
      edits.push({ id: allowed[1].id, replacement: '重叠替换' });
    }
    expect(() => repairs(draft, allowed, edits)).toThrow('已保留初稿');
    expect(draft).toContain('门轴发出细响');
  });

  it.each([10, 301, 700])('enforces both relative and absolute replacement bounds for a %i-character quote', (length) => {
    const text = '甲'.repeat(length);
    const [f] = grounded(text, [finding({ quote: text })]).findings;
    const maximum = Math.min(1200, Math.max(300, length * 2));
    expect(repairs(text, [f], [{ id: f.id, replacement: '乙'.repeat(maximum) }])).toBe('乙'.repeat(maximum));
    expect(() => repairs(text, [f], [{ id: f.id, replacement: '乙'.repeat(maximum + 1) }])).toThrow();
  });

  it('rejects deleting or whitespace-erasing long evidence, and schemas limit edits to three', () => {
    const text = '甲'.repeat(301);
    const [f] = grounded(text, [finding({ quote: text })]).findings;
    for (const replacement of ['', ' \n ']) {
      expect(() => repairs(text, [f], [{ id: f.id, replacement }])).toThrow('已保留初稿');
    }
    expect(() => repairSchema.parse({ edits: Array.from({ length: 4 }, (_, i) => ({ id: `finding-${i}`, replacement: 'x' })) })).toThrow();
  });
});

describe('scene outline relevance', () => {
  it('finds Chinese terms shifted by one code point within a longer intent', () => {
    const rows = [{ title: '城门钥匙', content: '守卫交班' }, { title: '草药', content: '山中采集' }];
    expect(rankSceneOutlines(rows, '取钥匙然后等待')).toEqual([rows[0]]);
  });

  it('ranks title matches ahead of content matches, drops unrelated rows, and keeps tie order without mutating input', () => {
    const rows = [
      { title: '桥边', content: '追踪钥匙' }, { title: '无关', content: '山中修行' },
      { title: '钥匙', content: '守卫交接' }, { title: '旧钥匙', content: '门口等待' },
    ];
    expect(rankSceneOutlines(rows, '钥匙')).toEqual([rows[2], rows[3], rows[0]]);
    expect(rows[0].title).toBe('桥边');
  });

  it('matches Latin terms case-insensitively and returns no evidence for an empty or irrelevant query', () => {
    const rows = [{ title: 'SECRET gate', content: 'portal' }, { title: '河边', content: '药草' }];
    expect(rankSceneOutlines(rows, 'Secret')).toEqual([rows[0]]);
    expect(rankSceneOutlines(rows, '')).toEqual([]);
    expect(rankSceneOutlines(rows, '钥匙')).toEqual([]);
  });
});
