import { describe, expect, it } from 'vitest';

import { codePointLength, codePointSlice, wordCount } from '../src/shared/text';

/**
 * 文本度量语义 —— 必须与 Python 对齐：
 *   len() / 切片按码点；_word_count 只剥 U+0020 和 \n。
 */
describe('wordCount', () => {
  it('中英文混合按码点计数', () => {
    expect(wordCount('你好world')).toBe(7);
  });

  it('只剥空格与换行，其他空白（全角空格、制表符）保留计数', () => {
    expect(wordCount('你 好\n世 界')).toBe(4);
    expect(wordCount('你\t好')).toBe(3); // \t 算 1 个字符（与 Python 一致）
    expect(wordCount('你　好')).toBe(3); // 全角空格也算
  });

  it('扩展区字符（代理对）按 1 个码点计', () => {
    // U+20BB8（CJK 扩展 B 区），UTF-16 里占 2 个码元
    expect('𠮸'.length).toBe(2);
    expect(wordCount('𠮸')).toBe(1);
    expect(wordCount('a𠮸b')).toBe(3);
  });

  it('空串与纯空白', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount(' \n ')).toBe(0);
  });
});

describe('codePoint 语义切片与长度', () => {
  it('slice 不会把代理对切一半', () => {
    expect(codePointSlice('a𠮸b𠮸c', 1, 4)).toBe('𠮸b𠮸');
  });

  it('length 与 Python len() 一致', () => {
    expect(codePointLength('a𠮸b')).toBe(3);
  });
});
