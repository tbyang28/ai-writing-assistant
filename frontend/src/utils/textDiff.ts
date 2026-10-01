import { diffArrays } from 'diff'

export type TextDiffSegment = {
  type: 'equal' | 'insert' | 'delete'
  text: string
}

/**
 * Builds a character-level diff while keeping Unicode code points intact.
 * The backend uses the same representation, so both preview surfaces can
 * render changes consistently.
 */
export function buildTextDiff(original: string, revised: string): TextDiffSegment[] {
  const parts = diffArrays(Array.from(original), Array.from(revised))
  const segments: TextDiffSegment[] = []

  for (const part of parts) {
    const text = part.value.join('')
    if (!text) continue
    const type = part.removed ? 'delete' : part.added ? 'insert' : 'equal'
    const previous = segments[segments.length - 1]
    if (previous?.type === type) {
      previous.text += text
    } else {
      segments.push({ type, text })
    }
  }

  return segments
}

export function replaceTextAtRange(
  original: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return original.slice(0, start) + replacement + original.slice(end)
}
