import { describe, expect, it } from 'vitest'
import { writingReplacement } from './writingReplacement'

describe('writing replacement', () => {
  it('retains paragraphs surrounding a selected polish target', () => {
    expect(writingReplacement('\n  原文\n\n', '改文', 'polish')).toBe('\n  改文\n\n')
  })
  it('retains the unprocessed tail of a correction longer than 3000 code points', () => {
    const original = '😀'.repeat(3000) + '未处理的尾部\n'
    expect(writingReplacement(original, '校对结果', 'fix')).toBe('校对结果未处理的尾部\n')
  })
  it('does not trim generated continuation', () => {
    expect(writingReplacement('', '\n新段落\n', 'continue')).toBe('\n新段落\n')
  })
})
