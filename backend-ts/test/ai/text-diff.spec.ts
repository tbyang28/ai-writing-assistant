import { describe, expect, it } from 'vitest';

import {
  buildTextDiff,
  estimatePolishDiffMaxTokens,
  summarizeDiff,
  type DiffSegment,
} from '../../src/ai/text-diff';

/** 按类型拼接：equal+delete 应重建原文，equal+insert 应重建改文 */
function joinBy(segments: DiffSegment[], types: DiffSegment['type'][]): string {
  return segments
    .filter((s) => types.includes(s.type))
    .map((s) => s.text)
    .join('');
}

describe('buildTextDiff', () => {
  it('相同文本只产生一个 equal 段', () => {
    expect(buildTextDiff('一模一样的文本', '一模一样的文本')).toEqual([
      { type: 'equal', text: '一模一样的文本' },
    ]);
  });

  it('任何输入下 equal+delete 可重建原文、equal+insert 可重建改文（核心不变量）', () => {
    const cases: Array<[string, string]> = [
      ['今天天气非常好', '今天天气特别棒'],
      ['他说他明天要去城里买些东西', '他说明天要进城买点东西'],
      ['纯粹新增', '纯粹新增一段全新的结尾'],
      ['开头被删掉了中间保留', '中间保留'],
      ['abc', 'xyz'],
      ['', '从无到有'],
      ['从有到无', ''],
      // 触发「≤4 字等片段粘连」的碎片化场景
      ['把好人换成坏人把好人换成坏人', '把坏人换成好人把坏人换成好人'],
    ];
    for (const [original, revised] of cases) {
      const segments = buildTextDiff(original, revised);
      expect(joinBy(segments, ['equal', 'delete'])).toBe(original);
      expect(joinBy(segments, ['equal', 'insert'])).toBe(revised);
      // 不产生空文本段
      for (const seg of segments) {
        expect(seg.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('纯新增：单个 insert 段', () => {
    expect(buildTextDiff('前文', '前文后续')).toEqual([
      { type: 'equal', text: '前文' },
      { type: 'insert', text: '后续' },
    ]);
  });

  it('纯删除：单个 delete 段', () => {
    expect(buildTextDiff('前文多余', '前文')).toEqual([
      { type: 'equal', text: '前文' },
      { type: 'delete', text: '多余' },
    ]);
  });

  it('替换场景产生 delete→insert 相邻对（UI 靠它渲染替换块）', () => {
    const segments = buildTextDiff('非常好', '特别棒');
    const types = segments.map((s) => s.type);
    expect(types).toContain('delete');
    expect(types).toContain('insert');
    const deleteIdx = types.indexOf('delete');
    expect(types[deleteIdx + 1]).toBe('insert');
  });

  it('等文粘连启发式：≤4 字等片段夹在两处改动之间不产生独立 equal 段', () => {
    // 「好」是夹在两次替换之间的 1 字等文，应被并入替换对而不是单独成段
    const segments = buildTextDiff('甲好乙好甲', '丙好丁好丙');
    expect(segments.some((s) => s.type === 'equal' && s.text === '好')).toBe(false);
    // 重建不变量仍然成立
    expect(joinBy(segments, ['equal', 'delete'])).toBe('甲好乙好甲');
    expect(joinBy(segments, ['equal', 'insert'])).toBe('丙好丁好丙');
  });
});

describe('summarizeDiff', () => {
  it('delete+insert 配对成「将X改为Y」', () => {
    const summaries = summarizeDiff([
      { type: 'equal', text: '前文' },
      { type: 'delete', text: '非常好' },
      { type: 'insert', text: '特别棒' },
    ]);
    expect(summaries).toEqual(['将「非常好」改为「特别棒」']);
  });

  it('连续的 delete+insert 依次配对；孤立段是删除/新增', () => {
    expect(
      summarizeDiff([
        { type: 'delete', text: '多余' },
        { type: 'insert', text: '补充' },
        { type: 'delete', text: '孤删' },
        { type: 'insert', text: '孤增' },
      ]),
    ).toEqual(['将「多余」改为「补充」', '将「孤删」改为「孤增」']);
    // 没有配对对象时才是删除/新增
    expect(summarizeDiff([{ type: 'delete', text: '多余' }])).toEqual(['删除「多余」']);
    expect(summarizeDiff([{ type: 'insert', text: '补充' }])).toEqual(['新增「补充」']);
  });

  it('空白差异不产生摘要', () => {
    expect(summarizeDiff([{ type: 'delete', text: '  ' }])).toEqual([]);
  });

  it('最多 6 条，长文本截断到 48 字', () => {
    const segments: DiffSegment[] = [];
    for (let i = 0; i < 8; i++) {
      segments.push({ type: 'delete', text: `旧${i}` }, { type: 'insert', text: `新${i}` });
    }
    const summaries = summarizeDiff(segments);
    expect(summaries).toHaveLength(6);

    const long = '长'.repeat(60);
    const [summary] = summarizeDiff([
      { type: 'delete', text: long },
      { type: 'insert', text: long },
    ]);
    expect(summary).toBe(`将「${'长'.repeat(48)}」改为「${'长'.repeat(48)}」`);
  });
});

describe('estimatePolishDiffMaxTokens', () => {
  it('公式 floor(len*1.4)+384，夹在 [512, 4096]', () => {
    expect(estimatePolishDiffMaxTokens('')).toBe(512); // 384 → 下限
    expect(estimatePolishDiffMaxTokens('9'.repeat(92))).toBe(512); // floor(128.8)+384=512
    expect(estimatePolishDiffMaxTokens('9'.repeat(93))).toBe(514); // floor(130.2)+384=514
    expect(estimatePolishDiffMaxTokens('9'.repeat(1000))).toBe(1784); // 1400+384
    expect(estimatePolishDiffMaxTokens('9'.repeat(3000))).toBe(4096); // 4584 → 上限
  });

  it('长度按码点计算（星形字符占 2 个 UTF-16 单元）', () => {
    expect(estimatePolishDiffMaxTokens('𝐀'.repeat(93))).toBe(514);
  });
});
