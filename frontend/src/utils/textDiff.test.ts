import { describe, expect, it } from 'vitest'

import { buildTextDiff, replaceTextAtRange } from './textDiff'

describe('buildTextDiff', () => {
  it('keeps unchanged text and marks a replacement as delete then insert', () => {
    expect(buildTextDiff('他走进门。', '他冲进门。')).toEqual([
      { type: 'equal', text: '他' },
      { type: 'delete', text: '走' },
      { type: 'insert', text: '冲' },
      { type: 'equal', text: '进门。' },
    ])
  })

  it('marks appended content as an insertion', () => {
    expect(buildTextDiff('第一段。', '第一段。\n第二段。')).toEqual([
      { type: 'equal', text: '第一段。' },
      { type: 'insert', text: '\n第二段。' },
    ])
  })

  it('replaces only the selected range', () => {
    expect(replaceTextAtRange('甲乙丙丁', 1, 3, '新')).toBe('甲新丁')
  })
})
