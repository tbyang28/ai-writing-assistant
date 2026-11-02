// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '@/api'
import AiPanel from './AiPanel.vue'
import { useAgentStore } from '@/stores/agent'
import { useBookStore, type Book } from '@/stores/book'
import type { AgentProposal } from '@/api/agent'

let app: App | undefined
let root: HTMLDivElement
const item = (): AgentProposal => ({
  id: 'proposal-ui', bookId: 'book-1', tool: 'save_inspiration', args: { title: '雨夜相遇', content: '主角在雨巷发现一封旧信。', tags: ['悬念'] },
  digest: 'c'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), status: 'pending',
})
const frame = (type: string, data: unknown) => `data: ${JSON.stringify({ type, data })}\n\n`
function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value }, cancel }), { headers: { 'content-type': 'text/event-stream' } })
  return { response, cancel, send: (text: string) => controller.enqueue(new TextEncoder().encode(text)) }
}
const button = (label: string) => {
  const match = Array.from(root.querySelectorAll('button')).find(node => node.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}\n${root.textContent}`)
  return match
}
async function tick() { await Promise.resolve(); await nextTick() }
function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const props = reactive({ bookId: 'book-1', chapterId: 'chapter-1', chapterContent: '未保存的当前正文' })
  const apply = vi.fn()
  app = createApp({ render: () => h(AiPanel, { ...props, onApplyChange: apply }) })
  app.use(pinia).mount(root)
  return { props, apply, store: useAgentStore(pinia), book: useBookStore(pinia) }
}
async function openAgent() { button('Agent').click(); await tick() }
async function sendTask(text = '整理一条灵感') {
  const input = root.querySelector<HTMLTextAreaElement>('#agent-message')!
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await tick()
}

beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
})
afterEach(() => { app?.unmount(); app = undefined; root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Agent panel interactions', () => {
  it('shows tool progress and unsaved parameters; failed confirmation retries the same proposal once', async () => {
    const stream = streamResponse()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response))
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('网络中断'))
    const { store, book, apply } = mount()
    book.currentBook = { id: 'book-1', inspirations: [] } as unknown as Book
    await openAgent()
    expect(button('Agent').getAttribute('aria-selected')).toBe('true')
    await sendTask()
    expect(button('停止生成')).toBeDefined()
    stream.send(frame('tool_call', { round: 1, name: 'save_inspiration', args: item().args, callId: 'call-1' }))
    await vi.waitFor(() => expect(root.textContent).toContain('进行中'))
    stream.send(frame('tool_result', { round: 1, name: 'save_inspiration', callId: 'call-1', ok: true, status: 'completed', preview: '提案已生成' })
      + frame('proposal', { proposal: item() }) + frame('done', {}) + 'data: [DONE]\n\n')
    await vi.waitFor(() => expect(store.isLoading).toBe(false))
    expect(root.textContent).toContain('尚未保存')
    expect(root.textContent).toContain('主角在雨巷发现一封旧信。')
    expect(root.textContent).toContain('悬念')
    expect(root.textContent).toContain('1/1 已完成')
    expect(post).not.toHaveBeenCalled()
    button('确认保存').click()
    await vi.waitFor(() => expect(root.textContent).toContain('网络中断'))
    expect(root.textContent).toContain('操作结果待核实')
    expect(root.textContent).toContain('不会重复新增')
    const saved = { ...item(), status: 'confirmed', result: { id: 'inspiration-1', tool: 'save_inspiration', created: true, inspiration: { id: 'inspiration-1', title: '雨夜相遇', content: '主角在雨巷发现一封旧信。', tags: '["悬念"]' } } }
    let resolve!: (value: any) => void
    post.mockImplementationOnce(() => new Promise(value => { resolve = value }))
    button('重试确认保存').click()
    await tick()
    expect(button('正在核实…').disabled).toBe(true)
    button('正在核实…').click()
    resolve({ data: saved })
    await vi.waitFor(() => expect(root.textContent).toContain('已确认 · 已保存'))
    expect(post.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['/ai/proposals/proposal-ui/confirm', { digest: 'c'.repeat(64) }],
      ['/ai/proposals/proposal-ui/confirm', { digest: 'c'.repeat(64) }],
    ])
    expect(book.currentBook.inspirations).toHaveLength(1)
    expect(apply).not.toHaveBeenCalled()
    expect(root.querySelectorAll('form')).toHaveLength(1)
  })

  it('cancels a proposal, stops generation, and keeps chapter edits on the existing review path', async () => {
    const stream = streamResponse()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response))
    const { store, apply } = mount()
    await openAgent()
    await sendTask()
    stream.send(frame('proposal', { proposal: item() }))
    await vi.waitFor(() => expect(root.textContent).toContain('尚未保存'))
    button('停止生成').click()
    await vi.waitFor(() => expect(root.textContent).toContain('已停止生成'))
    expect(stream.cancel).toHaveBeenCalled()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { ...item(), status: 'cancelled' } })
    button('取消提案').click()
    await vi.waitFor(() => expect(root.textContent).toContain('已取消 · 未保存'))
    expect(post).toHaveBeenCalledWith('/ai/proposals/proposal-ui/cancel', { digest: 'c'.repeat(64) })
    expect(store.proposals['proposal-ui'].proposal.status).toBe('cancelled')
    button('前往正文审阅').click()
    await tick()
    expect(button('写作').getAttribute('aria-selected')).toBe('true')
    expect(root.textContent).toContain('Diff 润色')
    expect(root.textContent).toContain('未保存的当前正文')
    expect(apply).not.toHaveBeenCalled()
  })

  it('clears chapter-specific input and aborts the old run when the chapter changes', async () => {
    const stream = streamResponse()
    const fetchMock = vi.fn().mockResolvedValue(stream.response)
    vi.stubGlobal('fetch', fetchMock)
    const { props, store } = mount()
    await openAgent()
    await sendTask('旧章节任务')
    props.chapterId = 'chapter-2'
    props.chapterContent = '第二章正文'
    await tick()
    expect(stream.cancel).toHaveBeenCalled()
    expect(store.turns).toHaveLength(0)
    expect(root.textContent).not.toContain('旧章节任务')
    expect(root.querySelector<HTMLTextAreaElement>('#agent-message')!.value).toBe('')
    expect(button('发送任务').disabled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not send Enter during IME composition, and aborts on unmount', async () => {
    const stream = streamResponse()
    const fetchMock = vi.fn().mockResolvedValue(stream.response)
    vi.stubGlobal('fetch', fetchMock)
    const { store } = mount()
    await openAgent()
    const input = root.querySelector<HTMLTextAreaElement>('#agent-message')!
    input.value = '整理人物'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(fetchMock).not.toHaveBeenCalled()
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    expect(fetchMock).not.toHaveBeenCalled()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    app!.unmount()
    app = undefined
    expect(store.isLoading).toBe(false)
    expect(stream.cancel).toHaveBeenCalled()
  })

  it('shows expired proposals without actionable save buttons', async () => {
    const stream = streamResponse()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response))
    mount()
    await openAgent()
    await sendTask()
    stream.send(frame('proposal', { proposal: { ...item(), expiresAt: new Date(Date.now() - 1000).toISOString() } }) + frame('done', {}) + 'data: [DONE]\n\n')
    await vi.waitFor(() => expect(root.textContent).toContain('提案已过期'))
    expect(Array.from(root.querySelectorAll('button')).some(node => node.textContent === '确认保存')).toBe(false)
    expect(root.textContent).toContain('有效期已结束')
  })
})
