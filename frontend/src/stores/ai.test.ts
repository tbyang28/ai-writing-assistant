import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiStore } from './ai'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  setActivePinia(createPinia())
})

describe('streamChat', () => {
  it('does not write an old response into a newly selected chapter', async () => {
    const store = useAiStore()
    store.loadChatHistory('book-1', 'chapter-1')

    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(streamController) { controller = streamController } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    const pending = store.streamChat('book-1', '第一章的问题', (chunk) => store.appendToLastAssistant(chunk), '第一章', 'chapter-1')
    await Promise.resolve()
    store.loadChatHistory('book-1', 'chapter-2')

    controller.enqueue(new TextEncoder().encode('data: {"type":"token","data":{"text":"第一章答案"}}\n\n'))
    controller.close()
    await pending

    expect(store.chatMessages).toEqual([])
    expect(localStorage.getItem('ai-writing-assistant:chat-history:book-1:chapter-2')).toBeNull()
  })
})

describe('stream cancellation', () => {
  it('stops immediately and ignores an old response even if fetch ignores abort', async () => {
    const store = useAiStore()
    let resolveOld!: (response: Response) => void
    let resolveNew!: (response: Response) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveNew = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const oldTokens = vi.fn()
    const old = store.streamWrite('b', '前文', 'continue', oldTokens)
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    store.stopGeneration()
    expect(signal.aborted).toBe(true)
    expect(store.isLoading).toBe(false)
    const freshTokens = vi.fn()
    const fresh = store.streamWrite('b', '新文', 'continue', freshTokens)
    resolveOld(new Response('data: {"type":"token","data":{"text":"旧结果"}}\n\n'))
    await old
    expect(oldTokens).not.toHaveBeenCalled()
    expect(store.isLoading).toBe(true)
    expect(store.error).toBeNull()
    resolveNew(new Response('data: {"type":"token","data":{"text":"新结果"}}\n\n'))
    expect(await fresh).toEqual({ answer: '新结果' })
    expect(freshTokens).toHaveBeenCalledWith('新结果')
  })

  it('can cancel a stream waiting for its next chunk without reporting an error', async () => {
    const store = useAiStore()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    const tokens = vi.fn()
    const pending = store.streamWrite('b', '原文', 'continue', tokens)
    controller.enqueue(new TextEncoder().encode('data: {"type":"token","data":{"text":"部分"}}\n\n'))
    await vi.waitFor(() => expect(tokens).toHaveBeenCalledWith('部分'))
    store.stopGeneration()
    expect(await pending).toBeNull()
    expect(store.error).toBeNull()
    expect(store.isLoading).toBe(false)
  })
})

it('uses the captured model and parses tokens split across network chunks', async () => {
  const store = useAiStore()
  store.selectedModel = 'new-model'
  const encoder = new TextEncoder()
  const responseText = 'data: {"type":"token","data":{"text":"你😀好"}}\n\ndata: [DONE]\n\n'
  const bytes = encoder.encode(responseText)
  const body = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(bytes.slice(0, 40)); c.enqueue(bytes.slice(40, 44)); c.enqueue(bytes.slice(44)); c.close()
  } })
  const fetchMock = vi.fn().mockResolvedValue(new Response(body))
  vi.stubGlobal('fetch', fetchMock)
  expect(await store.streamWrite('b', '原文', 'continue', vi.fn(), undefined, 'c', 'captured-model')).toEqual({ answer: '你😀好' })
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('captured-model')
})

it('cancels polish before its final result and preserves partial tokens for the caller', async () => {
  const store = useAiStore()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c } }))))
  const onToken = vi.fn()
  const pending = store.polishDiffStream('b', '原文', undefined, 'c', undefined, onToken)
  controller.enqueue(new TextEncoder().encode('data: {"type":"token","data":{"text":"部分改文"}}\n\n'))
  await vi.waitFor(() => expect(onToken).toHaveBeenCalledWith('部分改文', '部分改文'))
  store.stopGeneration()
  expect(await pending).toBeNull()
  expect(store.lastResponse).toBeNull()
  expect(store.error).toBeNull()
})
