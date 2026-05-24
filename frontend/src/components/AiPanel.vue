<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useAiStore } from '@/stores/ai'

const props = defineProps<{
  bookId: string
  chapterContent?: string
  chapterId?: string
}>()

const emit = defineEmits<{
  applyText: [text: string]
}>()

const aiStore = useAiStore()
const inputText = ref('')

async function sendMessage() {
  if (!inputText.value.trim() || aiStore.isLoading) return
  const msg = inputText.value
  inputText.value = ''
  await aiStore.sendMessage(props.bookId, msg, props.chapterContent, props.chapterId)
}

async function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    await sendMessage()
  }
}

async function runCommand(command: string) {
  if (!props.chapterContent) return

  // 先加入一个空白 AI 消息，流式输出会逐字填充它
  aiStore.addMessage('assistant', '')

  await aiStore.streamWrite(props.bookId, props.chapterContent, command, (chunk) => {
    // 每收到一个字就追加到最后一条助手消息末尾
    const msgs = aiStore.chatMessages
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'assistant') {
      last.content += chunk
    }
  })
}

function applySuggestion(text: string) {
  emit('applyText', text)
}

function handleStreamSend() {
  if (!inputText.value.trim() || aiStore.isLoading) return
  const msg = inputText.value
  inputText.value = ''
  aiStore.streamChat(props.bookId, msg, (chunk) => {
    // append to last assistant message
    const msgs = aiStore.chatMessages
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'assistant') {
      last.content += chunk
    }
  }, props.chapterContent, props.chapterId)
}
</script>

<template>
  <div class="bg-white border-l border-gray-200 flex flex-col h-full overflow-hidden shrink-0">
    <!-- Header -->
    <div class="h-12 flex items-center justify-between px-4 border-b border-gray-100">
      <span class="font-medium text-sm text-gray-900">AI 助手</span>
      <button @click="aiStore.closePanel()" class="text-gray-400 hover:text-gray-600">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>

    <!-- Quick Actions -->
    <div class="px-3 py-3 border-b border-gray-100">
      <div class="text-xs text-gray-500 mb-2">快捷操作</div>
      <div class="flex flex-wrap gap-2">
        <button @click="runCommand('continue')" :disabled="aiStore.isLoading" class="px-2.5 py-1.5 text-xs rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 disabled:opacity-50">
          续写
        </button>
        <button @click="runCommand('improve')" :disabled="aiStore.isLoading" class="px-2.5 py-1.5 text-xs rounded-lg bg-green-50 text-green-600 hover:bg-green-100 disabled:opacity-50">
          润色
        </button>
        <button @click="runCommand('fix')" :disabled="aiStore.isLoading" class="px-2.5 py-1.5 text-xs rounded-lg bg-orange-50 text-orange-600 hover:bg-orange-100 disabled:opacity-50">
          校对
        </button>
        <button @click="runCommand('summarize')" :disabled="aiStore.isLoading" class="px-2.5 py-1.5 text-xs rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-50">
          摘要
        </button>
      </div>
    </div>

    <!-- Chat Messages -->
    <div class="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
      <div v-if="aiStore.chatMessages.length === 0" class="text-center py-8">
        <p class="text-sm text-gray-400">在下方输入问题与 AI 对话</p>
        <p class="text-xs text-gray-300 mt-1">或使用快捷操作按钮</p>
      </div>

      <div v-for="(msg, idx) in aiStore.chatMessages" :key="idx" :class="msg.role === 'user' ? 'text-right' : 'text-left'">
        <div :class="msg.role === 'user'
          ? 'inline-block bg-brand text-white rounded-2xl rounded-tr-md px-3 py-2 text-sm max-w-[90%]'
          : 'inline-block bg-gray-100 text-gray-800 rounded-2xl rounded-tl-md px-3 py-2 text-sm max-w-[90%] whitespace-pre-wrap'">
          {{ msg.content }}
        </div>
        <div v-if="msg.role === 'assistant' && msg.content" class="mt-1 text-left">
          <button @click="applySuggestion(msg.content)" class="text-xs text-brand hover:text-brand-600">
            插入到编辑器
          </button>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="aiStore.isLoading" class="flex items-center gap-2 text-sm text-gray-400">
        <div class="w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin"></div>
        AI 思考中...
      </div>

      <div v-if="aiStore.error" class="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">
        {{ aiStore.error }}
      </div>
    </div>


    <!-- Input -->
    <div class="border-t border-gray-100 p-3">
      <div class="flex gap-2">
        <textarea
          v-model="inputText"
          @keydown="handleKeydown"
          placeholder="输入问题..."
          rows="2"
          class="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-brand"
        ></textarea>
      </div>
      <div class="flex justify-between mt-2">
        <button @click="aiStore.clearChat()" class="text-xs text-gray-400 hover:text-gray-600">清空对话</button>
        <div class="flex gap-2">
          <button @click="sendMessage" :disabled="aiStore.isLoading || !inputText.trim()" class="btn-primary text-xs px-3 py-1.5">
            {{ aiStore.isLoading ? '...' : '发送' }}
          </button>
          <button @click="handleStreamSend" :disabled="aiStore.isLoading || !inputText.trim()" class="btn-secondary text-xs px-3 py-1.5">
            流式
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
