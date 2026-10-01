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
