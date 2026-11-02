import { describe, expect, it } from 'vitest';

import { sourceVersion, uncoveredSources, type ContextSource } from '../../src/ai/agent/context-sources';

function source(overrides: Partial<ContextSource> = {}): ContextSource {
  return { id: 'chapter-1', version: 'v1', start: 20, end: 40, text: '章节片段', ...overrides };
}

const covered = [source({ start: 10, end: 100, text: '作品记忆中的较大范围' })];

describe('上下文来源去重', () => {
  it.each([
    { label: '完全相同范围', start: 10, end: 100 },
    { label: '内部子范围', start: 20, end: 40 },
    { label: '左端相同的子范围', start: 10, end: 40 },
    { label: '右端相同的子范围', start: 20, end: 100 },
  ])('同一来源、同版本的$label 已被包含时去重', async ({ start, end }) => {
    expect(uncoveredSources([source({ start, end })], covered)).toEqual([]);
  });

  it.each([
    { label: '版本变更', overrides: { version: 'v2' } },
    { label: '不同资料 ID', overrides: { id: 'chapter-2' } },
    { label: '向左扩展', overrides: { start: 0, end: 40 } },
    { label: '向右扩展', overrides: { start: 20, end: 120 } },
    { label: '覆盖旧范围的更大范围', overrides: { start: 0, end: 120 } },
    { label: '右侧相邻新范围', overrides: { start: 100, end: 120 } },
    { label: '左侧相邻新范围', overrides: { start: 0, end: 10 } },
    { label: '完全不相交的新范围', overrides: { start: 200, end: 300 } },
  ])('$label 保留完整候选片段', ({ overrides }) => {
    const candidate = source(overrides);
    expect(uncoveredSources([candidate], covered)).toEqual([candidate]);
  });

  it('文本相同不代表来源相同，去重依据 ID、版本和范围', () => {
    const original = source();
    const candidates = [source({ id: 'chapter-2' }), source({ version: 'v2' }),
      source({ start: 40, end: 60 })];
    expect(candidates.every((candidate) => candidate.text === original.text)).toBe(true);
    expect(uncoveredSources(candidates, [original])).toEqual(candidates);
  });

  it('遍历所有已覆盖来源，混合候选过滤后保持原序且不修改输入', () => {
    const candidates = [source({ id: 'chapter-2', text: '新章节' }),
      source(), source({ version: 'v2', text: '新版本' }),
      source({ start: 100, end: 120, text: '新范围' })];
    const prior = [source({ id: 'unrelated' }), ...covered];
    const originalCandidates = structuredClone(candidates);
    const originalPrior = structuredClone(prior);
    expect(uncoveredSources(candidates, prior)).toEqual([candidates[0], candidates[2], candidates[3]]);
    expect(candidates).toEqual(originalCandidates);
    expect(prior).toEqual(originalPrior);
  });

  it('无已知来源时保留全部片段，空候选返回空数组', () => {
    const candidates = [source(), source({ version: 'v2' })];
    expect(uncoveredSources(candidates, [])).toEqual(candidates);
    expect(uncoveredSources([], covered)).toEqual([]);
  });
});

describe('来源内容版本', () => {
  it('相同内容产生稳定版本，修改中文、码点或空白都会生成新版本', () => {
    const original = '少年𠮷站在山顶。\n';
    const version = sourceVersion(original);
    expect(sourceVersion(original)).toBe(version);
    const variants = ['少女𠮷站在山顶。\n', '少年吉站在山顶。\n', '少年𠮷站在山顶。'];
    expect(new Set([version, ...variants.map(sourceVersion)]).size).toBe(4);
    expect(version).toMatch(/^[a-f0-9]{64}$/);
  });
});
