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

  async function write(bookId: string, content: string, command: string, selectedText?: string) {
    isLoading.value = true
    error.value = null
    try {
      const token = localStorage.getItem('token')
      const res = await axios.post('/api/ai/write', {
        book_id: bookId, content, command, selected_text: selectedText,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = res.data
      lastResponse.value = data.data || data
      return lastResponse.value
    } catch (err: any) {
      error.value = err.response?.data?.message || 'AI 写作辅助失败'
      return null
    } finally {
      isLoading.value = false
    }
  }

  return {
    isLoading, error, lastResponse, isPanelOpen, selectedText, pendingInsert, chatMessages,
    setSelectedText, openPanel, closePanel, togglePanel, addMessage, clearChat,
    sendMessage, streamChat, write,
  }
})
