import { describe, expect, it } from 'vitest'
import { prepareAiChange, type AiChangeProposal } from './aiChange'

const proposal: AiChangeProposal = {
  chapterId: 'chapter-1',
  original: '甲乙丙丁',
  start: 1,
  end: 3,
  replacement: '新',
  label: 'AI 润色',
}

describe('prepareAiChange', () => {
  it('replaces only the captured selection', () => {
    expect(prepareAiChange('chapter-1', '甲乙丙丁', proposal)).toMatchObject({
      original: '甲乙丙丁',
      revised: '甲新丁',
      start: 1,
      end: 3,
    })
  })

  it('rejects a proposal when the chapter changed', () => {
    expect(prepareAiChange('chapter-2', '甲乙丙丁', proposal)).toBeNull()
  })

  it('rejects a proposal when the text changed after generation', () => {
    expect(prepareAiChange('chapter-1', '甲乙丙改', proposal)).toBeNull()
  })

  it('appends to an empty chapter', () => {
    expect(prepareAiChange('chapter-1', '', {
      chapterId: 'chapter-1', original: '', start: 0, end: 0,
      replacement: '第一句。', label: 'AI 续写',
    })?.revised).toBe('第一句。')
  })

  it('rejects an invalid range', () => {
    expect(prepareAiChange('chapter-1', '甲乙丙丁', { ...proposal, end: 9 })).toBeNull()
  })
})
