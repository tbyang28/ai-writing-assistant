<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAiStore } from '@/stores/ai'
import type { AiChangeProposal } from '@/utils/aiChange'

const MODEL_OPTIONS = [
  { label: 'DeepSeek-V4-Flash', value: 'deepseek-ai/DeepSeek-V4-Flash' },
  { label: 'DeepSeek-V3.2', value: 'deepseek-ai/DeepSeek-V3.2' },
  { label: 'GLM-4.7', value: 'zai-org/GLM-4.7' },
  { label: 'MiniMax-M2.5', value: 'MiniMaxAI/MiniMax-M2.5' },
]
type PanelMode = 'write' | 'chat'
type WriteCommand = 'continue' | 'fix' | 'summarize'
type WriteResult = { text: string; command: WriteCommand; description: string; original: string; chapterId: string; start: number; end: number; status: 'streaming' | 'ready' | 'error' }
type DiffContext = { chapterId: string; original: string; start: number; end: number }

const props = defineProps<{
  bookId: string
  chapterContent?: string
  chapterId?: string
  selectedText?: string
  selectionStart?: number
  selectionEnd?: number
}>()
const emit = defineEmits<{ applyChange: [proposal: AiChangeProposal] }>()
const aiStore = useAiStore()
const panelMode = ref<PanelMode>('write')
const inputText = ref('')
const isComposing = ref(false)
const compositionPending = ref(false)
const messagesRef = ref<HTMLElement | null>(null)
const diffInstruction = ref('')
const diffInstructionRef = ref<HTMLTextAreaElement | null>(null)
const isDiffLoading = ref(false)
const showDiffControls = ref(false)
const showSideBySide = ref(false)
const streamingDiffText = ref('')
const writeResult = ref<WriteResult | null>(null)
const diffResult = ref<Awaited<ReturnType<typeof aiStore.polishDiff>> | null>(null)
const diffContext = ref<DiffContext | null>(null)
let contextVersion = 0

const chapterContent = computed(() => props.chapterContent || '')
const hasSelection = computed(() => Boolean(props.selectedText) && (props.selectionEnd ?? 0) > (props.selectionStart ?? 0))
const targetLabel = computed(() => hasSelection.value ? '选中文本' : '整章正文')
const targetLength = computed(() => hasSelection.value ? props.selectedText?.length || 0 : chapterContent.value.length)
const targetPreview = computed(() => hasSelection.value ? props.selectedText || '' : chapterContent.value.slice(0, 72))
const isBusy = computed(() => aiStore.isLoading || isDiffLoading.value)
const writeResultStale = computed(() => Boolean(writeResult.value && (writeResult.value.chapterId !== props.chapterId || writeResult.value.original !== chapterContent.value)))
const diffResultStale = computed(() => Boolean(diffContext.value && (diffContext.value.chapterId !== props.chapterId || diffContext.value.original !== chapterContent.value)))
const diffTargetReady = computed(() => Boolean(hasSelection.value || chapterContent.value.trim()))
const diffTargetLabel = computed(() => '范围：' + targetLabel.value + ' · ' + targetLength.value + ' 字')
const diffRevisedPreview = computed(() => diffResult.value?.revised.slice(0, diffResult.value.processed_length ?? diffResult.value.revised.length) || '')
const diffStats = computed(() => {
  const segments = diffResult.value?.segments || []
  let addedChars = 0
  let removedChars = 0
  let replacements = 0
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const next = segments[index + 1]
    if (segment.type === 'delete' && next?.type === 'insert') { replacements += 1; index += 1 }
    else if (segment.type === 'delete') removedChars += segment.text.length
    else if (segment.type === 'insert') addedChars += segment.text.length
  }
  return { addedChars, removedChars, replacements }
})

function commandLabel(command: WriteCommand) {
  return { continue: '续写', fix: '校对', summarize: '摘要' }[command]
}
function commandDescription(command: WriteCommand) {
  return {
    continue: '接在当前章节末尾',
    fix: hasSelection.value ? '校对当前选中文本' : '校对整章正文',
    summarize: hasSelection.value ? '概括当前选中文本' : '概括整章正文',
  }[command]
}
function writeRange(command: WriteCommand) {
  if (command === 'continue') return { start: chapterContent.value.length, end: chapterContent.value.length }
  if (hasSelection.value) return { start: props.selectionStart || 0, end: props.selectionEnd || 0 }
  return { start: 0, end: chapterContent.value.length }
}
function scrollMessagesToEnd() {
  nextTick(() => { if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight })
}
function resetChapterContext() {
  contextVersion += 1
  aiStore.loadChatHistory(props.bookId, props.chapterId)
  writeResult.value = null
  diffResult.value = null
  diffContext.value = null
  showDiffControls.value = false
  streamingDiffText.value = ''
  inputText.value = ''
}
onMounted(resetChapterContext)
watch(() => [props.bookId, props.chapterId], resetChapterContext)
watch(() => [aiStore.chatMessages.length, aiStore.isLoading, writeResult.value?.text, streamingDiffText.value], scrollMessagesToEnd)

async function runCommand(command: WriteCommand) {
  if (isBusy.value || !props.chapterId || (!chapterContent.value && command !== 'continue')) return
  panelMode.value = 'write'
  aiStore.error = null
  const range = writeRange(command)
  const original = chapterContent.value
  const version = contextVersion
  const selected = command === 'continue' ? undefined : (hasSelection.value ? props.selectedText : undefined)
  writeResult.value = { text: '', command, description: commandDescription(command), original, chapterId: props.chapterId, start: range.start, end: range.end, status: 'streaming' }
  const result = await aiStore.streamWrite(props.bookId, original, command, (chunk) => {
    if (version === contextVersion && writeResult.value) writeResult.value.text += chunk
  }, selected, props.chapterId)
  if (version === contextVersion && writeResult.value?.command === command) writeResult.value.status = result?.answer ? 'ready' : 'error'
}
function previewWriteResult() {
  const result = writeResult.value
  if (!result?.text || result.command === 'summarize' || result.status !== 'ready' || writeResultStale.value) return
  emit('applyChange', { chapterId: result.chapterId, original: result.original, start: result.start, end: result.end, replacement: result.text, label: 'AI ' + commandLabel(result.command) + '预览' })
}
async function runPolishDiff() {
  if (isDiffLoading.value || aiStore.isLoading || !props.chapterId || !diffTargetReady.value) return
  panelMode.value = 'write'
  showDiffControls.value = true
  showSideBySide.value = false
  diffResult.value = null
  streamingDiffText.value = ''
  isDiffLoading.value = true
  const version = contextVersion
  const original = chapterContent.value
  const range = hasSelection.value ? { start: props.selectionStart || 0, end: props.selectionEnd || 0 } : { start: 0, end: original.length }
  diffContext.value = { chapterId: props.chapterId, original, ...range }
  try {
    const result = await aiStore.polishDiffStream(props.bookId, original, hasSelection.value ? props.selectedText : undefined, props.chapterId, diffInstruction.value, (_chunk, fullText) => {
      if (version === contextVersion) streamingDiffText.value = fullText
    })
    if (version === contextVersion) {
      diffResult.value = result
      streamingDiffText.value = ''
    }
  } finally {
    isDiffLoading.value = false
  }
}
function previewPolishDiff() {
  const result = diffResult.value
  const context = diffContext.value
  if (!result?.revised || !context || diffResultStale.value) return
  emit('applyChange', { chapterId: context.chapterId, original: context.original, start: context.start, end: context.end, replacement: result.revised, label: 'AI Diff 润色预览' })
}
function clearDiffReview() {
  diffResult.value = null
  diffContext.value = null
  streamingDiffText.value = ''
  showDiffControls.value = false
  showSideBySide.value = false
}
function focusDiffInstruction() { nextTick(() => diffInstructionRef.value?.focus()) }
function openDiffReview() { panelMode.value = 'write'; showDiffControls.value = true; focusDiffInstruction() }
function retryPolishDiff() { showDiffControls.value = true; focusDiffInstruction() }
function onCompositionEnd() {
  isComposing.value = false
  compositionPending.value = true
  setTimeout(() => { compositionPending.value = false }, 300)
}
async function sendChat() {
  if (!inputText.value.trim() || aiStore.isLoading) return
  const message = inputText.value.trim()
  inputText.value = ''
  const version = contextVersion
  await aiStore.streamChat(props.bookId, message, (chunk) => {
    if (version === contextVersion) aiStore.appendToLastAssistant(chunk)
  }, chapterContent.value, props.chapterId)
}
async function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing || isComposing.value) return
  if (compositionPending.value) { compositionPending.value = false; if (event.key === 'Enter') { event.preventDefault(); return } }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); await sendChat() }
}
</script>

<template>
  <div class="ai-panel-shell flex flex-col h-full overflow-hidden shrink-0 border-l w-full max-w-[100vw] animate-slide-in-right" :style="{ backgroundColor: 'var(--surface)', borderLeftColor: 'var(--border-clr)' }">
    <div class="flex items-center justify-between gap-3 px-4 py-3 border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
      <div class="flex items-center gap-2 min-w-0">
        <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand text-white" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3m0 12v3M5.6 5.6l2.2 2.2m8.4 8.4 2.2 2.2M3 12h3m12 0h3M5.6 18.4l2.2-2.2m8.4-8.4 2.2-2.2"/></svg></div>
        <div class="min-w-0"><div class="font-serif font-semibold text-sm truncate" :style="{ color: 'var(--text-primary)' }">AI 助手</div><div class="text-[11px]" :style="{ color: 'var(--text-muted)' }">写作和讨论分开处理</div></div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <select v-model="aiStore.selectedModel" aria-label="选择 AI 模型" class="text-[11px] border rounded-lg px-2 py-1 focus:outline-none max-w-[116px] truncate appearance-none cursor-pointer" :style="{ backgroundColor: 'var(--surface-secondary)', borderColor: 'var(--border-clr)', color: 'var(--text-secondary)' }"><option :value="null">默认模型</option><option v-for="option in MODEL_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option></select>
        <button type="button" @click="aiStore.closePanel()" class="shrink-0 rounded-lg p-2 transition-colors duration-150 hover:bg-[var(--surface-hover)]" :style="{ color: 'var(--text-muted)' }" aria-label="关闭 AI 助手"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></button>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-1 p-2 border-b" :style="{ borderBottomColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }" role="tablist" aria-label="AI 助手模式">
      <button type="button" role="tab" :aria-selected="panelMode === 'write'" @click="panelMode = 'write'" class="rounded-lg px-3 py-2 text-xs font-semibold transition-colors" :style="panelMode === 'write' ? { backgroundColor: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-soft)' } : { color: 'var(--text-muted)' }">写作</button>
      <button type="button" role="tab" :aria-selected="panelMode === 'chat'" @click="panelMode = 'chat'" class="rounded-lg px-3 py-2 text-xs font-semibold transition-colors" :style="panelMode === 'chat' ? { backgroundColor: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-soft)' } : { color: 'var(--text-muted)' }">问答</button>
    </div>

    <div ref="messagesRef" class="flex-1 overflow-y-auto min-h-0 p-4 space-y-3.5">
      <template v-if="panelMode === 'write'">
        <div class="rounded-xl border px-3 py-2.5" :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }"><div class="flex items-center justify-between gap-2"><div class="text-[11px] font-semibold uppercase tracking-wide" :style="{ color: 'var(--text-muted)' }">当前写作范围</div><span class="text-[11px] font-medium" :style="{ color: 'var(--brand-hover)' }">{{ targetLabel }} · {{ targetLength }} 字</span></div><div v-if="targetPreview" class="mt-1.5 text-xs leading-5 line-clamp-2" :style="{ color: 'var(--text-secondary)' }">{{ targetPreview }}{{ targetPreview.length >= 72 ? '…' : '' }}</div><div v-else class="mt-1.5 text-xs" :style="{ color: 'var(--text-muted)' }">先在编辑器输入正文，AI 才能基于上下文工作。</div></div>
        <div><div class="flex items-center justify-between mb-2"><div class="text-[11px] font-semibold uppercase tracking-wide" :style="{ color: 'var(--text-muted)' }">写作工具</div><span v-if="isBusy" class="inline-flex items-center gap-1 text-[11px]" :style="{ color: 'var(--brand-hover)' }"><span class="w-1.5 h-1.5 rounded-full bg-brand animate-pulse"></span>处理中</span></div><div class="grid grid-cols-2 gap-2"><button type="button" @click="runCommand('continue')" :disabled="isBusy || !props.chapterId" class="ai-action ai-action-primary">续写<span>接在章末</span></button><button type="button" @click="openDiffReview" :disabled="isBusy || !diffTargetReady" class="ai-action">润色<span>审阅后写回</span></button><button type="button" @click="runCommand('fix')" :disabled="isBusy || !chapterContent" class="ai-action">校对<span>错字与语病</span></button><button type="button" @click="runCommand('summarize')" :disabled="isBusy || !chapterContent" class="ai-action">摘要<span>提炼当前范围</span></button></div></div>
        <div v-if="showDiffControls" class="rounded-xl border p-3.5 space-y-2.5" :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }"><div class="flex items-center justify-between gap-2"><div><div class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">Diff 润色</div><div class="text-xs mt-0.5" :style="{ color: 'var(--text-muted)' }">{{ diffTargetLabel }}</div></div><button type="button" @click="runPolishDiff" :disabled="isDiffLoading || aiStore.isLoading || !diffTargetReady" class="btn-accent text-xs px-2.5 py-1.5 shrink-0">{{ isDiffLoading ? '生成中...' : diffResult ? '重新生成' : '生成审阅' }}</button></div><textarea ref="diffInstructionRef" v-model="diffInstruction" rows="2" placeholder="例如：增强画面感，保留人物语气" class="w-full text-xs border rounded-lg px-3 py-2 resize-none outline-none transition-colors duration-150 focus:ring-2 focus:ring-brand/25" :style="{ backgroundColor: 'var(--surface)', borderColor: 'var(--border-clr)', color: 'var(--text-primary)' }"></textarea></div>
        <div v-if="writeResult" class="rounded-xl border p-3.5 space-y-3" :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }"><div class="flex items-start justify-between gap-3"><div><div class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">AI {{ commandLabel(writeResult.command) }}</div><div class="text-xs mt-0.5" :style="{ color: 'var(--text-muted)' }">{{ writeResult.description }}</div></div><span class="text-[11px] shrink-0" :style="{ color: writeResult.status === 'error' ? '#a0432c' : 'var(--text-muted)' }">{{ writeResult.status === 'streaming' ? '生成中' : writeResult.status === 'error' ? '生成失败' : writeResultStale ? '正文已变化' : '可审阅' }}</span></div><div class="rounded-lg px-3 py-2.5 text-sm leading-6 whitespace-pre-wrap max-h-72 overflow-y-auto font-serif" :style="{ color: 'var(--text-primary)', backgroundColor: 'var(--surface)' }">{{ writeResult.text || 'AI 正在组织内容…' }}<span v-if="writeResult.status === 'streaming'" class="inline-block w-0.5 h-4 align-[-3px] ml-0.5 bg-brand animate-caret"></span></div><div class="flex items-center justify-between gap-2"><span class="text-[11px]" :style="{ color: 'var(--text-muted)' }">{{ writeResult.text.length }} 字</span><button v-if="writeResult.command !== 'summarize'" type="button" @click="previewWriteResult" :disabled="writeResult.status !== 'ready' || writeResultStale" class="btn-primary text-xs px-3 py-1.5">{{ writeResultStale ? '正文已变化，重新生成' : '预览写回' }}</button></div></div>
        <div v-if="isDiffLoading" class="rounded-xl border p-3.5" :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }"><div class="text-sm" :style="{ color: 'var(--text-secondary)' }">正在生成 Diff 审阅…</div><div class="text-xs mt-1" :style="{ color: 'var(--text-muted)' }">{{ streamingDiffText ? '已生成 ' + streamingDiffText.length + ' 字' : '正在读取当前范围' }}</div><div v-if="streamingDiffText" class="mt-3 text-sm leading-relaxed whitespace-pre-wrap rounded-lg p-3 max-h-48 overflow-y-auto font-serif" :style="{ color: 'var(--text-primary)', backgroundColor: 'var(--surface)' }">{{ streamingDiffText }}<span class="inline-block w-0.5 h-4 align-[-3px] ml-0.5 bg-brand animate-caret"></span></div></div>
        <div v-if="diffResult" class="rounded-xl border p-3.5 space-y-3" :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }"><div class="flex items-start justify-between gap-3"><div><div class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">Diff 审阅结果</div><div class="text-xs mt-0.5" :style="{ color: 'var(--text-muted)' }">{{ diffResultStale ? '正文已变化，这份结果不能写回' : '红色为删除，绿色为新增' }}</div></div><div class="flex items-center gap-1.5 shrink-0"><button type="button" @click="clearDiffReview" class="btn-secondary text-xs px-2.5 py-1">关闭</button><button type="button" @click="retryPolishDiff" class="btn-secondary text-xs px-2.5 py-1">重试</button></div></div><div class="grid grid-cols-3 gap-2 text-center text-xs"><div class="py-1.5 border-y" :style="{ borderColor: 'var(--border-clr)', color: 'var(--text-secondary)' }"><span class="font-semibold" :style="{ color: '#3e7a58' }">+{{ diffStats.addedChars }}</span><span class="ml-1">新增</span></div><div class="py-1.5 border-y" :style="{ borderColor: 'var(--border-clr)', color: 'var(--text-secondary)' }"><span class="font-semibold" :style="{ color: '#a0432c' }">-{{ diffStats.removedChars }}</span><span class="ml-1">删除</span></div><div class="py-1.5 border-y" :style="{ borderColor: 'var(--border-clr)', color: 'var(--text-secondary)' }"><span class="font-semibold" :style="{ color: 'var(--brand-hover)' }">{{ diffStats.replacements }}</span><span class="ml-1">替换</span></div></div><div class="text-sm leading-relaxed whitespace-pre-wrap rounded-lg p-3 max-h-64 overflow-y-auto font-serif" :style="{ color: 'var(--text-primary)', backgroundColor: 'var(--surface)' }"><template v-for="(segment, index) in diffResult.segments" :key="index"><span v-if="segment.type === 'equal'">{{ segment.text }}</span><del v-else-if="segment.type === 'delete'" class="px-0.5 rounded decoration-2" :style="{ backgroundColor: '#f3dcd5', color: '#a0432c', textDecorationColor: '#a0432c' }">{{ segment.text }}</del><ins v-else class="px-0.5 rounded no-underline" :style="{ backgroundColor: '#dfe8dc', color: '#3e6b48' }">{{ segment.text }}</ins></template></div><button type="button" @click="previewPolishDiff" :disabled="diffResultStale" class="w-full btn-primary text-xs py-2">{{ diffResultStale ? '正文已变化，无法写回' : '预览这次变更' }}</button><button type="button" @click="showSideBySide = !showSideBySide" class="text-xs transition-opacity hover:opacity-80" :style="{ color: 'var(--text-muted)' }">{{ showSideBySide ? '收起原文 / 修改后' : '展开原文 / 修改后' }}</button><div v-if="showSideBySide" class="grid grid-cols-2 gap-2"><div><div class="text-xs mb-1" :style="{ color: 'var(--text-muted)' }">原文</div><div class="text-xs leading-relaxed whitespace-pre-wrap rounded-lg p-2.5 max-h-32 overflow-y-auto" :style="{ color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }">{{ diffResult.original }}</div></div><div><div class="text-xs mb-1" :style="{ color: 'var(--text-muted)' }">修改后</div><div class="text-xs leading-relaxed whitespace-pre-wrap rounded-lg p-2.5 max-h-32 overflow-y-auto" :style="{ color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }">{{ diffRevisedPreview }}</div></div></div></div>
      </template>
      <template v-else>
        <div v-if="aiStore.chatMessages.length === 0" class="text-center py-10"><p class="font-serif text-sm" :style="{ color: 'var(--text-secondary)' }">把问题交给 AI，一起讨论情节、人物和设定</p><p class="text-xs mt-1.5" :style="{ color: 'var(--text-muted)' }">回答不会自动写入正文</p></div>
        <div v-for="(message, index) in aiStore.chatMessages" :key="index" class="animate-fade-up" :class="message.role === 'user' ? 'text-right' : 'text-left'"><div :class="message.role === 'user' ? 'inline-block rounded-2xl rounded-tr-md px-3.5 py-2.5 text-sm max-w-[90%]' : 'inline-block rounded-2xl rounded-tl-md px-3.5 py-2.5 text-sm max-w-[90%] whitespace-pre-wrap'" :style="message.role === 'user' ? { backgroundColor: 'var(--ink)', color: 'var(--ink-text)' } : { backgroundColor: 'var(--surface-secondary)', color: 'var(--text-primary)' }">{{ message.content || (aiStore.isLoading && index === aiStore.chatMessages.length - 1 ? 'AI 正在思考…' : '') }}</div></div>
        <div v-if="aiStore.isLoading" class="flex items-center gap-2 text-xs" :style="{ color: 'var(--text-muted)' }"><span class="w-1.5 h-1.5 rounded-full bg-brand animate-pulse"></span>正在生成回答</div>
      </template>
      <div v-if="aiStore.error" class="rounded-xl px-3 py-2.5 text-sm" :style="{ backgroundColor: '#f9e3dd', color: '#a0432c' }">{{ aiStore.error }}</div>
    </div>
    <div v-if="panelMode === 'chat'" class="border-t p-3.5" :style="{ borderTopColor: 'var(--border-clr)' }"><div class="rounded-xl border transition-colors duration-150" :style="{ backgroundColor: 'var(--surface-secondary)', borderColor: 'var(--border-clr)' }"><textarea v-model="inputText" @keydown="handleKeydown" @compositionstart="isComposing = true" @compositionend="onCompositionEnd" placeholder="输入问题，Enter 发送，Shift+Enter 换行" rows="2" class="w-full text-sm px-3.5 py-2.5 resize-none outline-none bg-transparent border-none" :style="{ color: 'var(--text-primary)' }"></textarea><div class="flex justify-between items-center px-3 pb-2.5"><button type="button" @click="aiStore.clearChat()" class="text-xs transition-opacity hover:opacity-80" :style="{ color: 'var(--text-muted)' }">清空问答</button><button type="button" @click="sendChat" :disabled="aiStore.isLoading || !inputText.trim()" class="btn-primary text-xs px-3.5 py-1.5">{{ aiStore.isLoading ? '生成中...' : '发送' }}</button></div></div></div>
    <div v-else class="border-t px-4 py-2.5 text-[11px]" :style="{ borderTopColor: 'var(--border-clr)', color: 'var(--text-muted)' }">选择一个写作工具，结果会先在这里审阅，再写回正文。</div>
  </div>
</template>

<style scoped>
.ai-action { display: flex; min-height: 52px; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; border: 1px solid var(--border-clr); border-radius: 10px; padding: 8px 11px; color: var(--text-primary); background: var(--surface); text-align: left; transition: border-color 150ms ease, background-color 150ms ease, opacity 150ms ease; }
.ai-action span { color: var(--text-muted); font-size: 11px; font-weight: 400; }
.ai-action:hover:not(:disabled) { border-color: var(--brand); background: var(--brand-softer); }
.ai-action:disabled { cursor: not-allowed; opacity: 0.45; }
.ai-action-primary { border-color: var(--brand); background: var(--brand-softer); }

@media (max-width: 768px) {
  .ai-panel-shell {
    position: fixed;
    inset: 0 0 0 auto;
    z-index: 60;
    width: min(100vw, 420px) !important;
    box-shadow: var(--shadow-lift);
  }
}
</style>
