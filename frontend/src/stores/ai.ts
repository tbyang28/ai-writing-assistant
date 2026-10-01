import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api'

export const useAiStore = defineStore('ai', () => {
  const HISTORY_PREFIX = 'ai-writing-assistant:chat-history'
  const HISTORY_LIMIT = 20
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const lastResponse = ref<any>(null)
  const isPanelOpen = ref(false)
  const selectedText = ref('')
  const pendingInsert = ref<string | null>(null)
  const chatMessages = ref<Array<{ role: string; content: string }>>([])
  const activeHistoryKey = ref<string | null>(null)
  // 当前选中的模型 ID（SiliconFlow model ID）
  const selectedModel = ref<string | null>(null)

  type PolishDiffResult = {
    original: string
    revised: string
    segments: Array<{ type: 'equal' | 'insert' | 'delete'; text: string }>
    summary: string[]
    instruction?: string
    truncated?: boolean
    original_length?: number
    processed_length?: number
  }

  type ExtractedCharacter = {
    name: string
    role: string
    bio: string
    confidence: number
  }

  function setSelectedText(text: string) {
    selectedText.value = text
  }

  function openPanel() { isPanelOpen.value = true }
  function closePanel() { stopGeneration(); isPanelOpen.value = false }
  function togglePanel() { isPanelOpen.value = !isPanelOpen.value }

  function addMessage(role: string, content: string) {
    chatMessages.value.push({ role, content })
    persistChatHistory()
  }

  function clearChat() {
    stopGeneration()
    chatMessages.value = []
    if (activeHistoryKey.value) {
      localStorage.removeItem(activeHistoryKey.value)
    }
  }

  function buildHistoryKey(bookId: string, chapterId?: string) {
    return `${HISTORY_PREFIX}:${bookId}:${chapterId || 'book'}`
  }

  function loadChatHistory(bookId: string, chapterId?: string) {
    const key = buildHistoryKey(bookId, chapterId)
    activeHistoryKey.value = key
    try {
      const raw = localStorage.getItem(key)
      if (!raw) {
        chatMessages.value = []
        return
      }
      const parsed = JSON.parse(raw)
      chatMessages.value = Array.isArray(parsed)
        ? parsed.filter((msg) => msg?.role && typeof msg.content === 'string').slice(-HISTORY_LIMIT)
        : []
    } catch {
      chatMessages.value = []
    }
  }

  function persistChatHistory() {
    if (!activeHistoryKey.value) return
    const messages = chatMessages.value
      .filter((msg) => msg.content.trim())
      .slice(-HISTORY_LIMIT)
    localStorage.setItem(activeHistoryKey.value, JSON.stringify(messages))
  }

  function replaceLastAssistantContent(content: string) {
    const last = chatMessages.value[chatMessages.value.length - 1]
    if (last && last.role === 'assistant') {
      last.content = content
      persistChatHistory()
    }
  }

  function appendToLastAssistant(text: string) {
    const last = chatMessages.value[chatMessages.value.length - 1]
    if (last && last.role === 'assistant') {
      last.content += text
      persistChatHistory()
    }
  }

  function streamUrl(path: string) {
    const baseURL = api.defaults.baseURL || '/api'
    return `${baseURL.replace(/\/$/, '')}${path}`
  }

  async function parseErrorResponse(response: Response) {
    try {
      const data = await response.json()
      return data?.detail || data?.message || `请求失败：${response.status}`
    } catch {
      return `请求失败：${response.status}`
    }
  }

  function parseAxiosError(err: any, fallback: string) {
    return (
      err?.response?.data?.detail ||
      err?.response?.data?.message ||
      err?.response?.data?.error?.message ||
      err?.message ||
      fallback
    )
  }

  async function sendMessage(bookId: string, message: string, currentContent?: string, chapterId?: string) {
    isLoading.value = true
    error.value = null
    addMessage('user', message)

    try {
      const res = await api.post('/ai/chat', {
        book_id: bookId,
        message,
        chapter_id: chapterId,
        current_content: currentContent,
        history: chatMessages.value.slice(-10, -1).map(m => ({ role: m.role, content: m.content })),
        model: selectedModel.value || undefined,
      })
      const data = res.data
      const payload = data.data || data
      const answer = payload.answer || payload.suggestion || ''
      addMessage('assistant', answer)
      lastResponse.value = payload
      return payload
    } catch (err: any) {
      error.value = parseAxiosError(err, 'AI 响应失败')
      addMessage('assistant', error.value || 'AI 响应失败')
      return null
    } finally {
      isLoading.value = false
    }
  }

  type StreamEvent = { type: string; data?: any }
  let activeStream: { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array> } | null = null

  function stopGeneration() {
    if (!activeStream) return
    const stream = activeStream
    activeStream = null
    stream.controller.abort()
    void stream.reader?.cancel().catch(() => {})
    isLoading.value = false
  }

  async function consumeStream(path: string, body: object, onEvent: (event: StreamEvent) => void, onComplete?: () => void) {
    stopGeneration()
    const stream = { controller: new AbortController(), reader: undefined as ReadableStreamDefaultReader<Uint8Array> | undefined }
    activeStream = stream
    isLoading.value = true
    error.value = null
    const signal = stream.controller.signal
    const isCurrent = () => activeStream === stream && !signal.aborted
    let abortListener!: () => void
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new DOMException('Stopped', 'AbortError'))
      signal.addEventListener('abort', abortListener, { once: true })
    })
    try {
      const response = await Promise.race([fetch(streamUrl(path), {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify(body),
      }).then(response => {
        if (!isCurrent()) {
          void response.body?.cancel().catch(() => {})
          throw new DOMException('Stopped', 'AbortError')
        }
        return response
      }), aborted])
      if (!response.ok) throw new Error(await parseErrorResponse(response))
      stream.reader = response.body?.getReader()
      if (!stream.reader) throw new Error('无法读取 AI 响应')
      const decoder = new TextDecoder()
      let buffer = ''
      function parseLine(line: string) {
        const trimmed = line.trim()
        if (!isCurrent() || !trimmed.startsWith('data:')) return
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') return
        let event: StreamEvent
        try { event = JSON.parse(payload) } catch { return }
        if (event.type === 'error') throw new Error(event.data?.message || 'AI 响应失败')
        onEvent(event)
      }
      while (isCurrent()) {
        const { done, value } = await Promise.race([stream.reader.read(), aborted])
        if (!isCurrent()) return false
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        lines.forEach(parseLine)
        if (done) { if (buffer) parseLine(buffer); break }
      }
      if (!isCurrent()) return false
      onComplete?.()
      return true
    } catch (err: any) {
      if (isCurrent()) error.value = err.message || 'AI 响应失败'
      return false
    } finally {
      signal.removeEventListener('abort', abortListener)
      void stream.reader?.cancel().catch(() => {})
      if (activeStream === stream) {
        activeStream = null
        isLoading.value = false
      }
    }
  }

  async function streamChat(bookId: string, message: string, onToken: (text: string) => void, currentContent?: string, chapterId?: string) {
    const responseHistoryKey = activeHistoryKey.value
    const history = chatMessages.value.slice(-10).map(m => ({ role: m.role, content: m.content }))
    addMessage('user', message)
    addMessage('assistant', '')
    let fullText = ''
    const completed = await consumeStream('/ai/chat/stream', {
      book_id: bookId, message, chapter_id: chapterId, current_content: currentContent,
      history, model: selectedModel.value || undefined,
    }, event => {
      if (event.type === 'token') {
        const text = event.data?.text || ''
        fullText += text
        if (activeHistoryKey.value === responseHistoryKey) onToken(text)
      }
    }, () => {
      if (activeHistoryKey.value === responseHistoryKey) {
        lastResponse.value = { answer: fullText }
        persistChatHistory()
      }
    })
    return completed ? { answer: fullText } : null
  }

  async function streamWrite(bookId: string, content: string, command: string, onToken: (text: string) => void, selectedText?: string, chapterId?: string, model = selectedModel.value) {
    let fullText = ''
    const completed = await consumeStream('/ai/write/stream', {
      book_id: bookId, content, command, chapter_id: chapterId, selected_text: selectedText, model: model || undefined,
    }, event => {
      if (event.type === 'token') {
        const text = event.data?.text || ''
        fullText += text
        onToken(text)
      }
    }, () => { lastResponse.value = { answer: fullText } })
    return completed ? { answer: fullText } : null
  }

  async function write(bookId: string, content: string, command: string, selectedText?: string, chapterId?: string) {
    isLoading.value = true
    error.value = null
    try {
      const res = await api.post('/ai/write', {
        book_id: bookId, content, command, chapter_id: chapterId, selected_text: selectedText,
        model: selectedModel.value || undefined,
      })
      const data = res.data
      const result = data.data || data
      const answer = result.answer || result.suggestion || ''
      addMessage('assistant', answer)
      return result
    } catch (err: any) {
      error.value = parseAxiosError(err, 'AI 写作辅助失败')
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function polishDiff(bookId: string, content: string, selectedText?: string, chapterId?: string, instruction?: string) {
    isLoading.value = true
    error.value = null
    try {
      const res = await api.post('/ai/polish-diff', {
        book_id: bookId,
        content,
        chapter_id: chapterId,
        selected_text: selectedText,
        instruction: instruction?.trim() || undefined,
        model: selectedModel.value || undefined,
      })
      const result = (res.data.data || res.data) as PolishDiffResult
      lastResponse.value = result
      return result
    } catch (err: any) {
      error.value = err.response?.data?.detail || err.message || 'AI Diff 润色失败'
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function polishDiffStream(
    bookId: string, content: string, selectedText?: string, chapterId?: string, instruction?: string,
    onToken?: (text: string, fullText: string) => void,
    onMeta?: (meta: Partial<PolishDiffResult>) => void,
    model = selectedModel.value,
  ) {
    let fullText = ''
    let result: PolishDiffResult | null = null
    const completed = await consumeStream('/ai/polish-diff/stream', {
      book_id: bookId, content, chapter_id: chapterId, selected_text: selectedText,
      instruction: instruction?.trim() || undefined, model: model || undefined,
    }, event => {
      if (event.type === 'meta') onMeta?.(event.data || {})
      if (event.type === 'token') {
        fullText += event.data?.text || ''
        onToken?.(event.data?.text || '', fullText)
      }
      if (event.type === 'result') result = event.data as PolishDiffResult
    }, () => {
      if (!result) throw new Error('AI 未返回完整审阅结果，请重新生成')
      lastResponse.value = result
    })
    return completed ? result as PolishDiffResult | null : null
  }

  async function extractCharacters(bookId: string, content: string, chapterId?: string) {
    isLoading.value = true
    error.value = null
    try {
      const res = await api.post('/ai/extract-characters', {
        book_id: bookId,
        content,
        chapter_id: chapterId,
        model: selectedModel.value || undefined,
      })
      const result = res.data.data || res.data
      lastResponse.value = result
      return (result.characters || []) as ExtractedCharacter[]
    } catch (err: any) {
      error.value = err.response?.data?.detail || err.message || 'AI 识别人物失败'
      return []
    } finally {
      isLoading.value = false
    }
  }

  return {
    isLoading, error, lastResponse, isPanelOpen, selectedText, pendingInsert, chatMessages, selectedModel,
    setSelectedText, openPanel, closePanel, togglePanel, addMessage, clearChat,
    loadChatHistory, persistChatHistory, replaceLastAssistantContent, appendToLastAssistant,
    sendMessage, streamChat, write, streamWrite, polishDiff, polishDiffStream, extractCharacters, stopGeneration,
  }
})
