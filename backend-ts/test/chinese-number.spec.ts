import { describe, expect, it } from 'vitest';

import { toChineseNumber } from '../src/shared/chinese-number';

/** 移植 backend/tests/utils/test_chinese_number.py 的全部用例 */
describe('toChineseNumber', () => {
  it.each([
    [1, '一'],
    [2, '二'],
    [9, '九'],
    [10, '十'],
    [11, '十一'],
    [13, '十三'],
    [19, '十九'],
    [20, '二十'],
    [21, '二十一'],
    [99, '九十九'],
    [100, '一百'],
    [101, '一百零一'],
    [105, '一百零五'],
    [110, '一百一十'],
    [111, '一百一十一'],
    [1000, '一千'],
    [1024, '一千零二十四'],
    [2026, '二千零二十六'],
    [10000, '一万'],
    [10001, '一万零一'],
    [10500, '一万零五百'],
    [100000, '十万'],
    [1100000, '一百一十万'],
  ])('%i → %s', (n, expected) => {
    expect(toChineseNumber(n)).toBe(expected);
  });

  it('章节标题格式', () => {
    expect(`第${toChineseNumber(1)}章`).toBe('第一章');
    expect(`第${toChineseNumber(13)}章`).toBe('第十三章');
  });

  it.each([0, -1, -100])('非正整数 %i 抛错', (n) => {
    expect(() => toChineseNumber(n)).toThrow();
  });

  it('超出范围（一亿）抛错', () => {
    expect(() => toChineseNumber(100000000)).toThrow();
  });

  it('非整数抛 TypeError（JS 里只有 1.5 / NaN 会走到这里）', () => {
    expect(() => toChineseNumber(1.5)).toThrow(TypeError);
    expect(() => toChineseNumber(Number.NaN)).toThrow(TypeError);
  });
});
