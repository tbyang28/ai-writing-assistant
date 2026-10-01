/** Textarea offsets use UTF-16, including for emoji. Freeze these with the original text. */
export function writingTarget(original: string, command: string, start = 0, end = 0, hasCursor = false) {
  const safeStart = Math.max(0, Math.min(start, original.length))
  const safeEnd = Math.max(safeStart, Math.min(end, original.length))
  if (command === 'continue') {
    const position = hasCursor ? safeEnd : original.length
    return { start: position, end: position, input: original.slice(0, position), selected: undefined }
  }
  const selected = safeEnd > safeStart
  return {
    start: selected ? safeStart : 0,
    end: selected ? safeEnd : original.length,
    input: original,
    selected: selected ? original.slice(safeStart, safeEnd) : undefined,
  }
}
