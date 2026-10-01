import { describe, expect, it } from 'vitest'
import { writingTarget } from './writingTarget'

describe('writing target', () => {
  it('uses only preceding text to continue at the cursor', () => {
    expect(writingTarget('前文后文', 'continue', 2, 2, true)).toEqual({ start: 2, end: 2, input: '前文', selected: undefined })
  })
  it('distinguishes a cursor at zero from an uncaptured cursor', () => {
    expect(writingTarget('原文', 'continue', 0, 0, true).start).toBe(0)
    expect(writingTarget('原文', 'continue', 0, 0, false).start).toBe(2)
  })
  it('continues after a selection without replacing it', () => {
    expect(writingTarget('前文后文', 'continue', 0, 2, true).end).toBe(2)
  })
  it('derives selected content from the frozen original', () => {
    expect(writingTarget('前文后文', 'polish', 0, 2, true)).toEqual({ start: 0, end: 2, input: '前文后文', selected: '前文' })
  })
})
