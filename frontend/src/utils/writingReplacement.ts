function preservePadding(original: string, revised: string) {
  return (original.match(/^\s*/)?.[0] || '') + revised.trim() + (original.match(/\s*$/)?.[0] || '')
}

/** The correction API processes the first 3000 code points; the polish API returns its own intact tail. */
export function writingReplacement(original: string, revised: string, command: string) {
  if (command === 'fix') {
    const points = Array.from(original)
    return preservePadding(points.slice(0, 3000).join(''), revised) + points.slice(3000).join('')
  }
  if (command === 'polish') return preservePadding(original, revised)
  return revised
}
