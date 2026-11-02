import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { actOnAgentProposal, isAgentProposal, requestAgent, streamAgent, type AgentEvent, type AgentProposal, type AgentRequest } from '@/api/agent'
import { useBookStore } from '@/stores/book'

export interface AgentToolProgress {
  id: string
  name: string
  round: number
  args: Record<string, unknown> | null
  status: 'running' | 'completed' | 'failed' | 'aborted'
  preview?: string
}
export interface ProposalState {
  proposal: AgentProposal
  busy: 'confirm' | 'cancel' | null
  error: string | null
  retryAction: 'confirm' | 'cancel' | null
  expired: boolean
}
export interface AgentTurn {
  id: number
  question: string
  answer: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  steps: Array<{ round: number; thought: string }>
  tools: AgentToolProgress[]
  proposalIds: string[]
  error: string | null
}
interface AgentSession {
  turns: AgentTurn[]
  proposals: Record<string, ProposalState>
}

function errorMessage(error: any, fallback: string) {
  return error?.response?.data?.detail || error?.response?.data?.message || error?.message || fallback
}

export const useAgentStore = defineStore('agent', () => {
  const sessions = ref<Record<string, AgentSession>>({})
  const activeKey = ref('')
  const isLoading = ref(false)
  let nextTurn = 0
  let activeRun: { controller: AbortController; turn: AgentTurn } | null = null
  const session = computed(() => sessions.value[activeKey.value])
  const turns = computed(() => session.value?.turns || [])
  const proposals = computed(() => session.value?.proposals || {})

  function cancelGeneration() {
    if (!activeRun) return
    const run = activeRun
    activeRun = null
    run.controller.abort()
    run.turn.status = 'cancelled'
    for (const tool of run.turn.tools) if (tool.status === 'running') tool.status = 'aborted'
    isLoading.value = false
  }

  function setContext(nextBookId: string, chapterId?: string) {
    const key = JSON.stringify([nextBookId, chapterId || null])
    if (activeKey.value === key) return
    cancelGeneration()
    activeKey.value = key
    sessions.value[key] ||= { turns: [], proposals: {} }
  }

  function addProposal(target: AgentSession, turn: AgentTurn, value: unknown, expectedBookId: string) {
    if (!isAgentProposal(value) || value.bookId !== expectedBookId) return
    // The original digest and terminal status must survive replayed SSE/result events.
    if (!target.proposals[value.id]) {
      target.proposals[value.id] = { proposal: value, busy: null, error: null, retryAction: null, expired: false }
    }
    if (!turn.proposalIds.includes(value.id)) turn.proposalIds.push(value.id)
  }

  async function sendMessage(
    nextBookId: string, message: string, currentContent?: string, chapterId?: string,
    model?: string | null, stream = true,
  ) {
    if (isLoading.value || !message.trim()) return
    setContext(nextBookId, chapterId)
    const target = session.value!
    const history = target.turns.filter(turn => turn.status === 'completed').slice(-5)
      .flatMap(turn => [{ role: 'user', content: turn.question }, { role: 'assistant', content: turn.answer }])
    target.turns.push({ id: ++nextTurn, question: message.trim(), answer: '', status: 'running', steps: [], tools: [], proposalIds: [], error: null })
    const turn = target.turns[target.turns.length - 1]
    const run = { controller: new AbortController(), turn }
    activeRun = run
    isLoading.value = true
    const payload: AgentRequest = {
      book_id: nextBookId, message: message.trim(), chapter_id: chapterId,
      current_content: currentContent, model: model || undefined, history,
    }
    const onEvent = (event: AgentEvent) => {
      if (activeRun !== run || run.controller.signal.aborted) return
      const data = event.data || {}
      if (event.type === 'token') turn.answer += typeof data.text === 'string' ? data.text : ''
      else if (event.type === 'step') turn.steps.push({ round: data.round, thought: data.thought || '' })
      else if (event.type === 'tool_call') {
        const id = data.callId || `${data.round}:${data.name}:${turn.tools.length}`
        if (!turn.tools.some(tool => tool.id === id)) {
          turn.tools.push({ id, name: data.name, round: data.round, args: data.args || null, status: 'running' })
        }
      } else if (event.type === 'tool_result') {
        const tool = data.callId ? turn.tools.find(tool => tool.id === data.callId)
          : turn.tools.find(tool => tool.name === data.name && tool.round === data.round && tool.status === 'running')
        if (tool) {
          tool.status = data.status === 'aborted' ? 'aborted' : data.ok === false || data.status === 'failed' ? 'failed' : 'completed'
          tool.preview = data.preview || data.content || ''
        }
      } else if (event.type === 'proposal') addProposal(target, turn, data.proposal, nextBookId)
      else if (event.type === 'result' || event.type === 'done') {
        if (typeof data.answer === 'string') turn.answer = data.answer
        else if (typeof data.content === 'string') turn.answer = data.content
        if (Array.isArray(data.proposals)) for (const proposal of data.proposals) addProposal(target, turn, proposal, nextBookId)
      } else if (event.type === 'run_end' && (data.status === 'failed' || data.status === 'aborted')) {
        // Continue reading: the following error frame carries the actionable provider/budget message.
        turn.status = 'failed'
        turn.error = data.status === 'aborted' ? 'Agent 执行已中断' : 'Agent 执行失败，请重试'
      }
    }
    try {
      if (stream) await streamAgent(payload, run.controller.signal, onEvent)
      else onEvent({ type: 'result', data: await requestAgent(payload, run.controller.signal) })
      if (activeRun === run && turn.status === 'running') turn.status = 'completed'
    } catch (error) {
      if (activeRun === run && !run.controller.signal.aborted) {
        turn.status = 'failed'
        turn.error = errorMessage(error, 'Agent 生成失败')
      }
    } finally {
      if (activeRun === run) {
        for (const tool of turn.tools) if (tool.status === 'running') tool.status = 'aborted'
        activeRun = null
        isLoading.value = false
      }
    }
  }

  async function resolveProposal(id: string, action: 'confirm' | 'cancel') {
    const item = proposals.value[id]
    if (!item || item.busy || item.proposal.status !== 'pending' || item.expired
      || (item.retryAction && item.retryAction !== action)) return
    // After an uncertain network failure, confirm may still retrieve a previously committed result after expiry.
    if (!item.retryAction && Date.parse(item.proposal.expiresAt) <= Date.now()) { item.expired = true; return }
    const original = item.proposal
    item.busy = action
    item.error = null
    try {
      const result = await actOnAgentProposal(original, action)
      if (!isAgentProposal(result) || result.id !== original.id || result.bookId !== original.bookId
        || result.digest !== original.digest || result.status !== (action === 'confirm' ? 'confirmed' : 'cancelled')
        || (action === 'confirm' && !result.result)) throw new Error('未收到有效的操作结果，请重试核实')
      item.proposal = result
      item.retryAction = null
      // Merge the returned record by ID. Never re-run a create endpoint or replace chapter/editor state.
      const book = useBookStore().currentBook
      if (result.status === 'confirmed' && book?.id === result.bookId) {
        const saved = result.result!
        if (saved.tool === 'save_character') {
          book.characters ||= []
          const index = book.characters.findIndex(character => character.id === saved.character.id)
          if (index < 0) book.characters.push(saved.character)
          else book.characters[index] = saved.character
        } else if (saved.tool === 'save_inspiration') {
          book.inspirations ||= []
          const index = book.inspirations.findIndex(inspiration => inspiration.id === saved.inspiration.id)
          if (index < 0) book.inspirations.push(saved.inspiration)
          else book.inspirations[index] = saved.inspiration
        }
      }
    } catch (error: any) {
      item.error = errorMessage(error, '操作失败，请重试')
      item.retryAction = action
      if (error?.response?.status === 410) item.expired = true
    } finally {
      // Captured proposal belongs to its original chapter even if the user has navigated away.
      item.busy = null
    }
  }

  return { turns, proposals, isLoading, setContext, sendMessage, cancelGeneration, resolveProposal }
})
