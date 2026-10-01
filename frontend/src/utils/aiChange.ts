import { replaceTextAtRange } from './textDiff'

export type AiChangeProposal = {
  chapterId: string
  original: string
  start: number
  end: number
  replacement: string
  label: string
}

export type PreparedAiChange = AiChangeProposal & {
  revised: string
}

/** Validate a response against the editor snapshot before showing it as writable. */
export function prepareAiChange(
  currentChapterId: string | null | undefined,
  currentContent: string,
  proposal: AiChangeProposal,
): PreparedAiChange | null {
  if (!currentChapterId || proposal.chapterId !== currentChapterId) return null
  if (proposal.original !== currentContent) return null
  if (!Number.isInteger(proposal.start) || !Number.isInteger(proposal.end)) return null
  if (proposal.start < 0 || proposal.end < proposal.start || proposal.end > currentContent.length) return null

  return {
    ...proposal,
    revised: replaceTextAtRange(currentContent, proposal.start, proposal.end, proposal.replacement),
  }
}
