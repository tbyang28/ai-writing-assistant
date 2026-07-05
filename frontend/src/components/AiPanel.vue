<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAiStore } from '@/stores/ai'

// 可选模型列表（显示名 → SiliconFlow model ID）
const MODEL_OPTIONS = [
  { label: 'DeepSeek-V4-Flash', value: 'deepseek-ai/DeepSeek-V4-Flash' },
  { label: 'DeepSeek-V3.2', value: 'deepseek-ai/DeepSeek-V3.2' },
  { label: 'GLM-4.7', value: 'zai-org/GLM-4.7' },
  { label: 'MiniMax-M2.5', value: 'MiniMaxAI/MiniMax-M2.5' },
]

const props = defineProps<{
  bookId: string
  chapterContent?: string
  chapterId?: string
  selectedText?: string
}>()

const emit = defineEmits<{
  applyText: [text: string]
  replaceText: [text: string]
}>()

const aiStore = useAiStore()
const inputText = ref('')
const isComposing = ref(false)
const compositionPending = ref(false)
const polishDiffResult = ref<Awaited<ReturnType<typeof aiStore.polishDiff>> | null>(null)
const diffInstruction = ref('')
const diffInstructionRef = ref<HTMLTextAreaElement | null>(null)
const isDiffLoading = ref(false)
const showDiffControls = ref(false)
const showSideBySide = ref(false)
const streamingDiffText = ref('')

const diffTargetReady = computed(() => Boolean(props.selectedText || props.chapterContent))
const diffTargetLabel = computed(() => (
  props.selectedText ? '范围：当前选中文本' : '范围：整章内容'
))
const diffRevisedPreview = computed(() => {
  const result = polishDiffResult.value
  if (!result) return ''
  return result.revised.slice(0, result.processed_length ?? result.revised.length)
})

const diffStats = computed(() => {
  const segments = polishDiffResult.value?.segments || []
  let addedChars = 0
  let removedChars = 0
  let replacements = 0

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    const next = segments[i + 1]
    if (segment.type === 'delete' && next?.type === 'insert') {
      replacements += 1
      i += 1
    } else if (segment.type === 'delete') {
      removedChars += segment.text.length
    } else if (segment.type === 'insert') {
      addedChars += segment.text.length
    }
  }

  return { addedChars, removedChars, replacements }
})

onMounted(() => {
  aiStore.loadChatHistory(props.bookId, props.chapterId)
})

watch(
  () => [props.bookId, props.chapterId],
  () => {
    aiStore.loadChatHistory(props.bookId, props.chapterId)
  },
)

async function sendMessage() {
  if (!inputText.value.trim() || aiStore.isLoading) return
  const msg = inputText.value
  inputText.value = ''
  await aiStore.sendMessage(props.bookId, msg, props.chapterContent, props.chapterId)
}

function onCompositionEnd() {
  isComposing.value = false
  compositionPending.value = true
  setTimeout(() => { compositionPending.value = false }, 300)
}

async function handleKeydown(e: KeyboardEvent) {
  if (e.isComposing || isComposing.value) return
  // IME composition 刚结束时浏览器可能合成一个 Enter keydown，
  // 这里忽略该次事件，防止按空格选词时误触发发送。
  if (compositionPending.value) {
    compositionPending.value = false
    if (e.key === 'Enter') {
      e.preventDefault()
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    await sendMessage()
  }
}

async function runCommand(command: string) {
  if (!props.chapterContent && command !== 'continue') return

  // 先加入一个空白 AI 消息，流式输出会逐字填充它
  aiStore.addMessage('assistant', '')

  await aiStore.streamWrite(props.bookId, props.chapterContent, command, (chunk) => {
    aiStore.appendToLastAssistant(chunk)
  }, undefined, props.chapterId)
}

async function runPolishDiff() {
  const target = props.selectedText || props.chapterContent
  if (!target || isDiffLoading.value || aiStore.isLoading) return
  showDiffControls.value = true
  showSideBySide.value = false
  polishDiffResult.value = null
  streamingDiffText.value = ''
  isDiffLoading.value = true
  try {
    polishDiffResult.value = await aiStore.polishDiffStream(
      props.bookId,
      props.chapterContent || '',
      props.selectedText || undefined,
      props.chapterId,
      diffInstruction.value,
      (_chunk, fullText) => {
        streamingDiffText.value = fullText
      },
    )
    streamingDiffText.value = ''
  } finally {
    isDiffLoading.value = false
  }
}

function applySuggestion(text: string) {
  emit('applyText', text)
}

function acceptPolishDiff() {
  if (!polishDiffResult.value?.revised) return
  emit('replaceText', polishDiffResult.value.revised)
  polishDiffResult.value = null
  streamingDiffText.value = ''
  showDiffControls.value = false
  showSideBySide.value = false
}

function rejectPolishDiff() {
  polishDiffResult.value = null
  streamingDiffText.value = ''
  showDiffControls.value = false
  showSideBySide.value = false
}

function focusDiffInstruction() {
  nextTick(() => {
    diffInstructionRef.value?.focus()
  })
}

function openDiffReview() {
  showDiffControls.value = true
  focusDiffInstruction()
}

function retryPolishDiff() {
  showDiffControls.value = true
  focusDiffInstruction()
}

function handleStreamSend() {
  if (!inputText.value.trim() || aiStore.isLoading) return
  const msg = inputText.value
  inputText.value = ''
  aiStore.streamChat(props.bookId, msg, (chunk) => {
    aiStore.appendToLastAssistant(chunk)
  }, props.chapterContent, props.chapterId)
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden shrink-0 border-l"
    :style="{ backgroundColor: 'var(--surface)', borderLeftColor: 'var(--border-clr)' }">
    <!-- Header -->
    <div class="h-12 flex items-center justify-between gap-2 px-3 border-b"
      :style="{ borderBottomColor: 'var(--border-clr)' }">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="font-medium text-sm shrink-0" :style="{ color: 'var(--text-primary)' }">AI 助手</span>
        <select v-model="aiStore.selectedModel"
          class="text-xs border rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand/40 max-w-[130px] truncate appearance-none cursor-pointer"
          :style="{
            backgroundColor: 'var(--surface-secondary)',
            borderColor: 'var(--border-clr)',
            color: 'var(--text-secondary)'
          }">
          <option :value="null">默认模型</option>
          <option v-for="opt in MODEL_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </div>
      <button @click="aiStore.closePanel()" class="shrink-0 rounded-lg p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
        :style="{ color: 'var(--text-muted)' }">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>

    <!-- Quick Actions -->
    <div class="px-3 py-3 border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
      <div class="text-xs mb-2" :style="{ color: 'var(--text-muted)' }">快捷操作</div>
      <div class="flex flex-wrap gap-2">
        <button @click="runCommand('continue')" :disabled="aiStore.isLoading"
          class="px-2.5 py-1.5 text-xs rounded-lg font-medium disabled:opacity-50 transition-colors
            bg-indigo-50 text-indigo-600 hover:bg-indigo-100
            dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50">
          续写
        </button>
        <button @click="runCommand('improve')" :disabled="aiStore.isLoading"
          class="px-2.5 py-1.5 text-xs rounded-lg font-medium disabled:opacity-50 transition-colors
            bg-green-50 text-green-600 hover:bg-green-100
            dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50">
          润色
        </button>
        <button @click="openDiffReview" :disabled="aiStore.isLoading || !diffTargetReady"
          class="px-2.5 py-1.5 text-xs rounded-lg font-medium disabled:opacity-50 transition-colors
            bg-emerald-50 text-emerald-700 hover:bg-emerald-100
            dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50">
          Diff 润色
        </button>
        <button @click="runCommand('fix')" :disabled="aiStore.isLoading"
          class="px-2.5 py-1.5 text-xs rounded-lg font-medium disabled:opacity-50 transition-colors
            bg-orange-50 text-orange-600 hover:bg-orange-100
            dark:bg-orange-900/30 dark:text-orange-400 dark:hover:bg-orange-900/50">
          校对
        </button>
        <button @click="runCommand('summarize')" :disabled="aiStore.isLoading"
          class="px-2.5 py-1.5 text-xs rounded-lg font-medium disabled:opacity-50 transition-colors
            bg-blue-50 text-blue-600 hover:bg-blue-100
            dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50">
          摘要
        </button>
      </div>
    </div>

    <!-- Chat Messages -->
    <div class="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
      <div v-if="aiStore.chatMessages.length === 0 && !showDiffControls && !polishDiffResult && !isDiffLoading" class="text-center py-8">
        <p class="text-sm" :style="{ color: 'var(--text-muted)' }">在下方输入问题与 AI 对话</p>
        <p class="text-xs mt-1" :style="{ color: 'var(--text-muted)' }">或使用快捷操作按钮</p>
      </div>

      <div v-if="showDiffControls" class="rounded-lg border p-3 space-y-2"
        :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }">
        <div class="flex items-center justify-between gap-2">
          <div>
            <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">Diff 润色要求</div>
            <div class="text-xs mt-0.5" :style="{ color: 'var(--text-muted)' }">{{ diffTargetLabel }}</div>
          </div>
          <button @click="runPolishDiff" :disabled="isDiffLoading || aiStore.isLoading || !diffTargetReady"
            class="btn-primary text-xs px-2.5 py-1.5 disabled:opacity-50 shrink-0">
            {{ isDiffLoading ? '流式生成中...' : polishDiffResult ? '重新生成' : '生成审阅' }}
          </button>
        </div>
        <textarea
          ref="diffInstructionRef"
          v-model="diffInstruction"
          rows="3"
          placeholder="更有画面感、压缩节奏、保留人物语气"
          class="w-full text-xs border rounded-lg px-2.5 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-400/30 transition-colors"
          :style="{
            backgroundColor: 'var(--surface)',
            borderColor: 'var(--border-clr)',
            color: 'var(--text-primary)'
          }"
        ></textarea>
      </div>

      <div v-for="(msg, idx) in aiStore.chatMessages" :key="idx" :class="msg.role === 'user' ? 'text-right' : 'text-left'">
        <div :class="msg.role === 'user'
          ? 'inline-block bg-brand text-white rounded-2xl rounded-tr-md px-3 py-2 text-sm max-w-[90%]'
          : 'inline-block rounded-2xl rounded-tl-md px-3 py-2 text-sm max-w-[90%] whitespace-pre-wrap'"
          :style="msg.role === 'assistant' ? { backgroundColor: 'var(--surface-secondary)', color: 'var(--text-primary)' } : {}">
          {{ msg.content }}
        </div>
        <div v-if="msg.role === 'assistant' && msg.content" class="mt-1 text-left">
          <button @click="applySuggestion(msg.content)" class="text-xs text-brand hover:text-brand-600">
            插入到编辑器
          </button>
        </div>
      </div>

      <div v-if="isDiffLoading" class="rounded-lg border p-3"
        :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }">
        <div class="flex items-center gap-2 text-sm" :style="{ color: 'var(--text-secondary)' }">
          <div class="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
          正在流式生成 AI 润色...
        </div>
        <div class="text-xs mt-1 pl-6" :style="{ color: 'var(--text-muted)' }">
          {{ streamingDiffText ? `已生成 ${streamingDiffText.length} 字，完成后自动生成 diff` : '等待模型开始返回内容' }}
        </div>
        <div v-if="streamingDiffText" class="mt-3 text-sm leading-relaxed whitespace-pre-wrap rounded p-2 max-h-48 overflow-y-auto font-serif"
          :style="{ color: 'var(--text-primary)', backgroundColor: 'var(--surface)' }">
          {{ streamingDiffText }}
        </div>
      </div>

      <div v-if="polishDiffResult" class="rounded-lg border p-3 space-y-3"
        :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }">
        <div class="flex items-center justify-between gap-2">
          <div>
            <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">AI 修改审阅</div>
            <div class="text-xs mt-0.5" :style="{ color: 'var(--text-muted)' }">
              {{ selectedText ? '接受后替换当前选中文本' : '接受后替换整章内容' }}
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button @click="rejectPolishDiff" class="btn-secondary text-xs px-2 py-1">
              拒绝
            </button>
            <button @click="retryPolishDiff" class="btn-secondary text-xs px-2 py-1">
              调整重试
            </button>
            <button @click="acceptPolishDiff" class="btn-primary text-xs px-2 py-1">
              接受
            </button>
          </div>
        </div>

        <div v-if="polishDiffResult.truncated" class="text-xs rounded px-2 py-1.5"
          :style="{ color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }">
          本次只审阅前 {{ polishDiffResult.processed_length }} 字，接受后会保留剩余
          {{ (polishDiffResult.original_length || 0) - (polishDiffResult.processed_length || 0) }} 字原文。
        </div>

        <div class="grid grid-cols-3 gap-2 text-center text-xs">
          <div class="py-1.5 border-y" :style="{ borderColor: 'var(--border-clr)', color: 'var(--text-secondary)' }">
            <span class="font-semibold text-green-600 dark:text-green-300">+{{ diffStats.addedChars }}</span>
            <span class="ml-1">纯新增字</span>
          </div>
          <div class="py-1.5 border-y" :style="{ borderColor: 'var(--border-clr)', color: 'var(--text-secondary)' }">
            <span class="font-semibold text-red-600 dark:text-red-300">-{{ diffStats.removedChars }}</span>
            <span class="ml-1">纯删除字</span>
          </div>
          <div class="py-1.5 border-y" :style="{ borderColor: 'var(--border-clr)', color: 'var(--text-secondary)' }">
            <span class="font-semibold text-amber-600 dark:text-amber-300">{{ diffStats.replacements }}</span>
            <span class="ml-1">处替换</span>
          </div>
        </div>

        <div v-if="polishDiffResult.summary.length" class="space-y-1">
          <div class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">主要改动</div>
          <div v-for="(item, idx) in polishDiffResult.summary" :key="idx"
            class="text-xs rounded px-2 py-1"
            :style="{ color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }">
            {{ item }}
          </div>
        </div>

        <div class="space-y-1">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">对比预览</div>
            <div class="flex items-center gap-2 text-[11px]" :style="{ color: 'var(--text-muted)' }">
              <span><span class="inline-block w-2 h-2 rounded-sm bg-red-200 dark:bg-red-900/70"></span> 删除</span>
              <span><span class="inline-block w-2 h-2 rounded-sm bg-green-200 dark:bg-green-900/70"></span> 新增</span>
            </div>
          </div>
          <div class="text-sm leading-relaxed whitespace-pre-wrap rounded p-2 max-h-64 overflow-y-auto font-serif"
            :style="{ color: 'var(--text-primary)', backgroundColor: 'var(--surface)' }">
            <template v-for="(segment, idx) in polishDiffResult.segments" :key="idx">
              <span v-if="segment.type === 'equal'">{{ segment.text }}</span>
              <del v-else-if="segment.type === 'delete'" class="px-0.5 rounded bg-red-100 text-red-700 decoration-red-500 dark:bg-red-900/40 dark:text-red-300">{{ segment.text }}</del>
              <ins v-else class="px-0.5 rounded no-underline bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">{{ segment.text }}</ins>
            </template>
          </div>
        </div>

        <div class="space-y-2">
          <button @click="showSideBySide = !showSideBySide" class="text-xs hover:opacity-80"
            :style="{ color: 'var(--text-muted)' }">
            {{ showSideBySide ? '收起原文/润色后' : '展开原文/润色后' }}
          </button>
          <div v-if="showSideBySide" class="grid grid-cols-2 gap-2">
            <div>
              <div class="text-xs mb-1" :style="{ color: 'var(--text-muted)' }">原文</div>
              <div class="text-xs leading-relaxed whitespace-pre-wrap rounded p-2 max-h-32 overflow-y-auto"
                :style="{ color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }">
                {{ polishDiffResult.original }}
              </div>
            </div>
            <div>
              <div class="text-xs mb-1" :style="{ color: 'var(--text-muted)' }">润色后</div>
              <div class="text-xs leading-relaxed whitespace-pre-wrap rounded p-2 max-h-32 overflow-y-auto"
                :style="{ color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }">
                {{ diffRevisedPreview }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="aiStore.isLoading && !isDiffLoading" class="flex items-center gap-2 text-sm" :style="{ color: 'var(--text-muted)' }">
        <div class="w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin"></div>
        AI 思考中...
      </div>

      <div v-if="aiStore.error" class="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
        {{ aiStore.error }}
      </div>
    </div>

    <!-- Input -->
    <div class="border-t p-3" :style="{ borderTopColor: 'var(--border-clr)' }">
      <div class="flex gap-2">
        <textarea
          v-model="inputText"
          @keydown="handleKeydown"
          @compositionstart="isComposing = true"
          @compositionend="onCompositionEnd"
          placeholder="输入问题..."
          rows="2"
          class="flex-1 text-sm border rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-brand/40 transition-colors"
          :style="{
            backgroundColor: 'var(--surface-secondary)',
            borderColor: 'var(--border-clr)',
            color: 'var(--text-primary)'
          }"
        ></textarea>
      </div>
      <div class="flex justify-between mt-2">
        <button @click="aiStore.clearChat()" class="text-xs hover:opacity-80" :style="{ color: 'var(--text-muted)' }">清空对话</button>
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
