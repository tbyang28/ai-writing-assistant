import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '@/api'
import { useAgentStore } from './agent'
import { useBookStore, type Book } from './book'
import { useAiStore } from './ai'
import type { AgentProposal } from '@/api/agent'

const proposal = (overrides: Partial<AgentProposal> = {}): AgentProposal => ({
  id: 'proposal-1', bookId: 'book-1', tool: 'save_character', args: { name: '林舟', role: '主角', bio: '雨巷里的旅人' },
  digest: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), status: 'pending', ...overrides,
})
const frame = (type: string, data: unknown) => `data: ${JSON.stringify({ type, data })}\r\n\r\n`
function respond(text: string, split = false) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (split) for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7))
    else controller.enqueue(bytes)
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
}
function pendingStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value }, cancel }), { headers: { 'content-type': 'text/event-stream' } })
  return { response, cancel, send: (text: string) => controller.enqueue(new TextEncoder().encode(text)) }
}
function confirmed(value = proposal()): AgentProposal {
  return { ...value, status: 'confirmed', result: { id: 'character-1', tool: 'save_character', created: true, character: { id: 'character-1', name: '林舟' } } }
}
async function seed(value = proposal()) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(frame('proposal', { proposal: value }) + frame('done', {}))))
  const store = useAgentStore()
  await store.sendMessage('book-1', '整理人物', '正文', 'chapter-1')
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'jwt') })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Agent generation', () => {
  it('sends draft/model context, tracks out-of-order tools, and deduplicates proposals without saving', async () => {
    const item = proposal()
    const post = vi.spyOn(api, 'post')
    const fetchMock = vi.fn().mockResolvedValue(respond(
      frame('step', { round: 1, thought: '检索设定' })
      + frame('tool_call', { round: 1, name: 'get_characters', args: {}, callId: 'a' })
      + frame('tool_call', { round: 1, name: 'get_characters', args: { name: '配角' }, callId: 'b' })
      + frame('tool_result', { round: 1, name: 'get_characters', ok: false, callId: 'b', status: 'failed', content: '读取失败' })
      + frame('tool_result', { round: 1, name: 'get_characters', ok: true, callId: 'a', status: 'completed', preview: '已读取' })
      + frame('proposal', { proposal: item }) + frame('proposal', { proposal: item })
      + frame('proposal', { proposal: proposal({ id: 'foreign', bookId: 'book-2' }) })
      + frame('token', { text: '人物已整理。', runId: 'run-1', seq: 8 }) + frame('done', { proposals: [item] }) + 'data: [DONE]', true))
    vi.stubGlobal('fetch', fetchMock)
    const store = useAgentStore()
    await store.sendMessage('book-1', '整理人物', '未保存的草稿', 'chapter-1', 'chosen-model')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/agent/stream')
    const request = fetchMock.mock.calls[0][1]
    expect(request.headers.Authorization).toBe('Bearer jwt')
    expect(JSON.parse(request.body)).toEqual({ book_id: 'book-1', message: '整理人物', current_content: '未保存的草稿', chapter_id: 'chapter-1', model: 'chosen-model', history: [] })
    expect(store.turns[0]).toMatchObject({ answer: '人物已整理。', status: 'completed', proposalIds: ['proposal-1'] })
    expect(store.turns[0].tools.map(tool => [tool.id, tool.status])).toEqual([['a', 'completed'], ['b', 'failed']])
    expect(Object.keys(store.proposals)).toEqual(['proposal-1'])
    expect(post).not.toHaveBeenCalled()
    expect(useAiStore().pendingInsert).toBeNull()
    expect(useAiStore().chatMessages).toEqual([])
  })

  it('supports nonstream proposals arrays and completed-turn history', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { data: { answer: '请确认人物', proposals: [proposal()] } } })
    const store = useAgentStore()
    await store.sendMessage('book-1', '整理人物', '', 'chapter-1', null, false)
    expect(store.turns[0].answer).toBe('请确认人物')
    expect(store.proposals['proposal-1'].proposal.status).toBe('pending')
    await store.sendMessage('book-1', '继续', '', 'chapter-1', null, false)
    expect(post.mock.calls[1][1]).toMatchObject({ history: [{ role: 'user', content: '整理人物' }, { role: 'assistant', content: '请确认人物' }] })
  })

  it('accepts a JSON response on the stream request without issuing a fallback request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { answer: '收到', proposals: [proposal()] } }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const store = useAgentStore()
    await store.sendMessage('book-1', '整理人物', '', 'chapter-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.turns[0].answer).toBe('收到')
    expect(store.turns[0].proposalIds).toEqual(['proposal-1'])
  })

  it('aborts generation, releases the stream, and keeps received proposals actionable', async () => {
    const stream = pendingStream()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response))
    const store = useAgentStore()
    const pending = store.sendMessage('book-1', '整理人物', '', 'chapter-1')
    stream.send(frame('proposal', { proposal: proposal() }) + frame('tool_call', { round: 1, name: 'get_outline', callId: 'tool' }))
    await vi.waitFor(() => expect(store.turns[0].proposalIds).toHaveLength(1))
    store.cancelGeneration()
    await pending
    expect(stream.cancel).toHaveBeenCalled()
    expect(store.isLoading).toBe(false)
    expect(store.turns[0]).toMatchObject({ status: 'cancelled', error: null })
    expect(store.turns[0].tools[0].status).toBe('aborted')
    expect(store.proposals['proposal-1'].proposal.status).toBe('pending')
  })

  it('ignores an old fetch response after switching chapters, even when a new run has started', async () => {
    let resolveOld!: (response: Response) => void
    const newStream = pendingStream()
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(newStream.response))
    const store = useAgentStore()
    const oldRun = store.sendMessage('book-1', '旧问题', '旧正文', 'chapter-1')
    store.setContext('book-1', 'chapter-2')
    const newRun = store.sendMessage('book-1', '新问题', '新正文', 'chapter-2')
    resolveOld(respond(frame('proposal', { proposal: proposal() }) + frame('token', { text: '旧答案' }) + frame('done', {})))
    await oldRun
    expect(store.isLoading).toBe(true)
    expect(store.turns).toHaveLength(1)
    expect(store.turns[0]).toMatchObject({ question: '新问题', answer: '', error: null })
    expect(store.proposals).toEqual({})
    newStream.send(frame('token', { text: '新答案' }) + 'data: [DONE]\n\n')
    await newRun
    expect(store.turns[0].answer).toBe('新答案')
    store.setContext('book-1', 'chapter-1')
    expect(store.turns[0].status).toBe('cancelled')
  })

  it.each([
    ['in-band error', frame('error', { message: '模型暂不可用' }), '模型暂不可用'],
    ['terminal then error', frame('run_end', { status: 'failed' }) + frame('error', { message: '当前任务超过输入预算，请缩小范围' }), '超过输入预算'],
    ['truncated stream', frame('token', { text: '部分回答' }), '连接中断'],
    ['invalid frame', 'data: {broken}\n\n', '格式错误'],
  ])('reports %s and preserves received proposals', async (_name, ending, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(frame('proposal', { proposal: proposal() }) + ending)))
    const store = useAgentStore()
    await store.sendMessage('book-1', '整理人物', '', 'chapter-1')
    expect(store.turns[0].status).toBe('failed')
    expect(store.turns[0].error).toContain(expected)
    expect(store.proposals['proposal-1'].proposal.status).toBe('pending')
    expect(store.isLoading).toBe(false)
  })
})

describe('Agent proposal actions', () => {
  it('locks repeated clicks and retries the same ID/digest after a lost confirmation response', async () => {
    const store = await seed()
    const bookStore = useBookStore()
    bookStore.currentBook = { id: 'book-1', characters: [{ id: 'character-1', name: '旧名字' }] } as Book
    bookStore.currentChapter = { id: 'chapter-1', content: '未保存正文' } as any
    let rejectFirst!: (error: Error) => void
    const post = vi.spyOn(api, 'post').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValue({ data: confirmed() })
    const first = store.resolveProposal('proposal-1', 'confirm')
    await store.resolveProposal('proposal-1', 'confirm')
    await store.resolveProposal('proposal-1', 'cancel')
    expect(post).toHaveBeenCalledTimes(1)
    rejectFirst(new Error('网络连接断开'))
    await first
    expect(store.proposals['proposal-1']).toMatchObject({ busy: null, error: '网络连接断开', retryAction: 'confirm' })
    // An uncertain confirmation can be reconciled even after the proposal's original expiry.
    store.proposals['proposal-1'].proposal.expiresAt = new Date(Date.now() - 1000).toISOString()
    await store.resolveProposal('proposal-1', 'cancel')
    await store.resolveProposal('proposal-1', 'confirm')
    expect(post.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['/ai/proposals/proposal-1/confirm', { digest: 'a'.repeat(64) }],
      ['/ai/proposals/proposal-1/confirm', { digest: 'a'.repeat(64) }],
    ])
    expect(store.proposals['proposal-1'].proposal.status).toBe('confirmed')
    expect(bookStore.currentBook.characters).toEqual([{ id: 'character-1', name: '林舟' }])
    expect(bookStore.currentChapter?.content).toBe('未保存正文')
    await store.resolveProposal('proposal-1', 'confirm')
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('cancels with the digest and never adds a saved record', async () => {
    const store = await seed()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { ...proposal(), status: 'cancelled' } })
    await store.resolveProposal('proposal-1', 'cancel')
    expect(post).toHaveBeenCalledWith('/ai/proposals/proposal-1/cancel', { digest: 'a'.repeat(64) })
    expect(store.proposals['proposal-1'].proposal.status).toBe('cancelled')
    expect(useBookStore().currentBook).toBeNull()
  })

  it('keeps a late confirmation scoped to its original chapter and book', async () => {
    const store = await seed()
    const bookStore = useBookStore()
    let resolve!: (value: any) => void
    vi.spyOn(api, 'post').mockImplementation(() => new Promise(value => { resolve = value }))
    const pending = store.resolveProposal('proposal-1', 'confirm')
    store.setContext('book-2', 'chapter-2')
    bookStore.currentBook = { id: 'book-2', characters: [] } as unknown as Book
    resolve({ data: confirmed() })
    await pending
    expect(store.turns).toEqual([])
    expect(store.proposals).toEqual({})
    expect(bookStore.currentBook.characters).toEqual([])
    store.setContext('book-1', 'chapter-1')
    expect(store.proposals['proposal-1'].proposal.status).toBe('confirmed')
  })

  it('retries cancellation with the original digest and never calls confirm', async () => {
    const store = await seed()
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('取消结果未收到'))
      .mockResolvedValueOnce({ data: { ...proposal(), status: 'cancelled' } })
    await store.resolveProposal('proposal-1', 'cancel')
    expect(store.proposals['proposal-1'].retryAction).toBe('cancel')
    await store.resolveProposal('proposal-1', 'confirm')
    await store.resolveProposal('proposal-1', 'cancel')
    expect(post.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['/ai/proposals/proposal-1/cancel', { digest: 'a'.repeat(64) }],
      ['/ai/proposals/proposal-1/cancel', { digest: 'a'.repeat(64) }],
    ])
    expect(store.proposals['proposal-1'].proposal.status).toBe('cancelled')
  })

  it('does not let replayed proposal events reset a confirmed proposal', async () => {
    const stream = pendingStream()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response))
    const store = useAgentStore()
    const pending = store.sendMessage('book-1', '整理人物', '', 'chapter-1')
    const original = proposal()
    stream.send(frame('proposal', { proposal: original }))
    await vi.waitFor(() => expect(store.proposals['proposal-1']).toBeDefined())
    vi.spyOn(api, 'post').mockResolvedValue({ data: confirmed(original) })
    await store.resolveProposal('proposal-1', 'confirm')
    stream.send(frame('proposal', { proposal: original }) + frame('done', { proposals: [original] }) + 'data: [DONE]\n\n')
    await pending
    expect(store.proposals['proposal-1'].proposal.status).toBe('confirmed')
    expect(store.turns[0].proposalIds).toEqual(['proposal-1'])
  })

  it('does not submit an expired proposal and respects server expiry', async () => {
    const store = await seed(proposal({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
    const post = vi.spyOn(api, 'post')
    await store.resolveProposal('proposal-1', 'confirm')
    expect(post).not.toHaveBeenCalled()
    expect(store.proposals['proposal-1'].expired).toBe(true)
    store.proposals['proposal-1'].expired = false
    store.proposals['proposal-1'].proposal.expiresAt = new Date(Date.now() + 60_000).toISOString()
    post.mockRejectedValue({ response: { status: 410, data: { detail: '提案已过期' } } })
    await store.resolveProposal('proposal-1', 'cancel')
    expect(store.proposals['proposal-1']).toMatchObject({ expired: true, error: '提案已过期' })
  })

  it('requires the returned proposal to match the ID, book, and digest', async () => {
    const store = await seed()
    vi.spyOn(api, 'post').mockResolvedValue({ data: confirmed(proposal({ digest: 'b'.repeat(64) })) })
    await store.resolveProposal('proposal-1', 'confirm')
    expect(store.proposals['proposal-1'].proposal.status).toBe('pending')
    expect(store.proposals['proposal-1'].retryAction).toBe('confirm')
  })
})
