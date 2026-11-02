import { api, apiPost } from '@/api'
import type { Character, Inspiration } from '@/stores/book'

export type AgentProposalResult =
  | { id: string; tool: 'save_character'; created: boolean; character: Character }
  | { id: string; tool: 'save_inspiration'; created: boolean; inspiration: Inspiration }

export interface AgentProposal {
  id: string
  bookId: string
  tool: 'save_character' | 'save_inspiration'
  args: Record<string, unknown>
  digest: string
  expiresAt: string
  status: 'pending' | 'confirmed' | 'cancelled'
  result?: AgentProposalResult
}

export interface AgentRequest {
  book_id: string
  message: string
  chapter_id?: string
  current_content?: string
  history: Array<{ role: string; content: string }>
  model?: string
}

export interface AgentEvent {
  type: string
  data?: Record<string, any>
}

export interface AgentResponse {
  answer?: string
  content?: string
  proposals?: AgentProposal[]
}

export function isAgentProposal(value: any): value is AgentProposal {
  return Boolean(value && typeof value.id === 'string' && typeof value.bookId === 'string'
    && ['save_character', 'save_inspiration'].includes(value.tool)
    && value.args && typeof value.args === 'object' && !Array.isArray(value.args)
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
    && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))
    && ['pending', 'confirmed', 'cancelled'].includes(value.status))
}

export function requestAgent(payload: AgentRequest, signal: AbortSignal) {
  return api.post<AgentResponse | { data: AgentResponse }>('/ai/agent', payload, { signal })
    .then(({ data }) => 'data' in data ? data.data : data)
}

export function actOnAgentProposal(proposal: AgentProposal, action: 'confirm' | 'cancel') {
  return apiPost<AgentProposal>(`/ai/proposals/${encodeURIComponent(proposal.id)}/${action}`, { digest: proposal.digest })
}

/** Read complete SSE frames, including split UTF-8, CRLF and a final frame without a newline. */
export async function streamAgent(payload: AgentRequest, signal: AbortSignal, onEvent: (event: AgentEvent) => void) {
  const baseURL = api.defaults.baseURL || '/api'
  const token = localStorage.getItem('token')
  const response = await fetch(`${baseURL.replace(/\/$/, '')}/ai/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
    signal,
  })
  signal.throwIfAborted()
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.detail || body?.message || `请求失败：${response.status}`)
  }
  // Accept a JSON response without reissuing a request that could create another proposal.
  if (response.headers.get('content-type')?.includes('application/json')) {
    const body = await response.json()
    signal.throwIfAborted()
    onEvent({ type: 'result', data: body.data || body })
    return
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('无法读取 Agent 响应')
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  let completed = false
  let sentinel = false
  const dispatch = () => {
    if (!dataLines.length) return
    const raw = dataLines.join('\n')
    dataLines = []
    if (raw === '[DONE]') { completed = true; sentinel = true; return }
    let event: AgentEvent
    try { event = JSON.parse(raw) } catch { throw new Error('Agent 响应格式错误，请重试') }
    signal.throwIfAborted()
    if (event.type === 'error') throw new Error(event.data?.message || 'Agent 生成失败')
    onEvent(event)
    if (event.type === 'done') completed = true
  }
  const line = (value: string) => {
    const text = value.replace(/\r$/, '')
    if (!text) dispatch()
    else if (text.startsWith('data:')) dataLines.push(text.slice(5).replace(/^ /, ''))
  }
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (!sentinel) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while (!sentinel && (newline = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (done) { if (buffer) line(buffer); dispatch(); break }
    }
    if (!completed) throw new Error('Agent 连接中断；已收到的提案仍可确认，请重试未完成的问题')
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
