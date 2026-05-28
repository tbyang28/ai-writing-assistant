import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export const useAiStore = defineStore('ai', () => {
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const lastResponse = ref<any>(null)
  const isPanelOpen = ref(false)
  const selectedText = ref('')
  const pendingInsert = ref<string | null>(null)
  const chatMessages = ref<Array<{ role: string; content: string }>>([])
  // 当前选中的模型 ID（SiliconFlow model ID）
  const selectedModel = ref<string | null>(null)

  type PolishDiffResult = {
    original: string
    revised: string
    segments: Array<{ type: 'equal' | 'insert' | 'delete'; text: string }>
    summary: string[]
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
  function closePanel() { isPanelOpen.value = false }
  function togglePanel() { isPanelOpen.value = !isPanelOpen.value }

  function addMessage(role: string, content: string) {
    chatMessages.value.push({ role, content })
  }

  function clearChat() {
    chatMessages.value = []
  }

  async function sendMessage(bookId: string, message: string, currentContent?: string, chapterId?: string) {
    isLoading.value = true
    error.value = null
    addMessage('user', message)

    try {
      const token = localStorage.getItem('token')
      const res = await axios.post('/api/ai/chat', {
        book_id: bookId,
        message,
        chapter_id: chapterId,
        current_content: currentContent,
        history: chatMessages.value.slice(-10, -1).map(m => ({ role: m.role, content: m.content })),
        model: selectedModel.value || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = res.data
      const payload = data.data || data
      const answer = payload.answer || payload.suggestion || ''
      addMessage('assistant', answer)
      lastResponse.value = payload
      return payload
    } catch (err: any) {
      error.value = err.message || 'AI 响应失败'
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function streamChat(bookId: string, message: string, onToken: (text: string) => void, currentContent?: string, chapterId?: string) {
    isLoading.value = true
    error.value = null
    addMessage('user', message)

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          book_id: bookId,
          message,
          chapter_id: chapterId,
          current_content: currentContent,
          history: chatMessages.value.slice(-10, -1).map(m => ({ role: m.role, content: m.content })),
          model: selectedModel.value || undefined,
        }),
      })

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No reader available')

      const decoder = new TextDecoder()
      let fullText = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const dataStr = trimmed.slice(6)
          if (dataStr === '[DONE]') continue

          try {
            const parsed = JSON.parse(dataStr)
            if (parsed.type === 'token') {
              const text = parsed.data?.text || ''
              fullText += text
              onToken(text)
            }
          } catch { /* skip parse errors */ }
        }
      }

      addMessage('assistant', fullText)
      lastResponse.value = { answer: fullText }
      return { answer: fullText }
    } catch (err: any) {
      error.value = err.message || '流式响应失败'
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function streamWrite(bookId: string, content: string, command: string, onToken: (text: string) => void, selectedText?: string, chapterId?: string) {
    isLoading.value = true
    error.value = null

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/ai/write/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          book_id: bookId,
          content,
          command,
          chapter_id: chapterId,
          selected_text: selectedText,
          model: selectedModel.value || undefined,
        }),
      })

      // 用 Streams API 读取 SSE 流，一段一段解析
      const reader = response.body?.getReader()
      if (!reader) throw new Error('No reader available')

      const decoder = new TextDecoder()
      let fullText = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // 把二进制数据解码成字符串
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''  // 最后一行可能不完整，留到下轮处理

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const dataStr = trimmed.slice(6)
          if (dataStr === '[DONE]') continue

          try {
            const parsed = JSON.parse(dataStr)
            if (parsed.type === 'token') {
              const text = parsed.data?.text || ''
              fullText += text
              onToken(text)  // 回调：每收到一个字就通知前端更新
            }
          } catch { /* 跳过解析失败的 chunk */ }
        }
      }

      lastResponse.value = { answer: fullText }
      return { answer: fullText }
    } catch (err: any) {
      error.value = err.message || '流式响应失败'
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function write(bookId: string, content: string, command: string, selectedText?: string, chapterId?: string) {
    isLoading.value = true
    error.value = null
    try {
      const token = localStorage.getItem('token')
      const res = await axios.post('/api/ai/write', {
        book_id: bookId, content, command, chapter_id: chapterId, selected_text: selectedText,
        model: selectedModel.value || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = res.data
      const result = data.data || data
      const answer = result.answer || result.suggestion || ''
      addMessage('assistant', answer)
      return result
    } catch (err: any) {
      error.value = err.response?.data?.message || 'AI 写作辅助失败'
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function polishDiff(bookId: string, content: string, selectedText?: string, chapterId?: string) {
    isLoading.value = true
    error.value = null
    try {
      const token = localStorage.getItem('token')
      const res = await axios.post('/api/ai/polish-diff', {
        book_id: bookId,
        content,
        chapter_id: chapterId,
        selected_text: selectedText,
        model: selectedModel.value || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
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

  async function extractCharacters(bookId: string, content: string, chapterId?: string) {
    isLoading.value = true
    error.value = null
    try {
      const token = localStorage.getItem('token')
      const res = await axios.post('/api/ai/extract-characters', {
        book_id: bookId,
        content,
        chapter_id: chapterId,
        model: selectedModel.value || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
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
    sendMessage, streamChat, write, streamWrite, polishDiff, extractCharacters,
  }
})
