<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAiStore } from '@/stores/ai'
import type { AiChangeProposal } from '@/utils/aiChange'
import { writingTarget } from '@/utils/writingTarget'
import { writingReplacement } from '@/utils/writingReplacement'
import { buildTextDiff } from '@/utils/textDiff'

const MODEL_OPTIONS = [
  { label: 'DeepSeek-V4-Flash', value: 'deepseek-ai/DeepSeek-V4-Flash' },
  { label: 'DeepSeek-V3.2', value: 'deepseek-ai/DeepSeek-V3.2' },
  { label: 'GLM-4.7', value: 'zai-org/GLM-4.7' },
  { label: 'MiniMax-M2.5', value: 'MiniMaxAI/MiniMax-M2.5' },
]
type Action = 'continue' | 'polish' | 'fix' | 'summarize' | 'custom'
type Draft = {
  chapterId: string; original: string; start: number; end: number; model: string | null
  command: Exclude<Action, 'custom'>; input: string; selected?: string; instruction: string
  text: string; status: 'streaming' | 'ready' | 'stopped' | 'error'; description: string; truncated?: boolean
}
const props = defineProps<{
  bookId: string; chapterContent?: string; chapterId?: string; selectedText?: string
  selectionStart?: number; selectionEnd?: number; hasCursor?: boolean
}>()
const emit = defineEmits<{ applyChange: [proposal: AiChangeProposal] }>()
const aiStore = useAiStore()
const panelMode = ref<'write' | 'chat'>('write')
const placement = ref<'cursor' | 'end'>('cursor')
const instruction = ref('')
const instructionRef = ref<HTMLTextAreaElement | null>(null)
const customOpen = ref(false)
const adjusting = ref(false)
const showOriginal = ref(false)
const draft = ref<Draft | null>(null)
const inputText = ref('')
const messagesRef = ref<HTMLElement | null>(null)
const followOutput = ref(true)
let version = 0
const isComposing = ref(false)
let compositionEndedAt = 0
const content = computed(() => props.chapterContent || '')
const hasSelection = computed(() => (props.selectionEnd || 0) > (props.selectionStart || 0))
const targetText = computed(() => hasSelection.value ? content.value.slice(props.selectionStart, props.selectionEnd) : content.value)
const targetLabel = computed(() => hasSelection.value ? `选中 ${targetText.value.length} 字` : `整章 ${content.value.length} 字`)
const stale = computed(() => !!draft.value && (draft.value.chapterId !== props.chapterId || draft.value.original !== content.value))
const ready = computed(() => draft.value?.status === 'ready' && !aiStore.isLoading && !stale.value && !!draft.value.text)
const segments = computed(() => draft.value ? buildTextDiff(draft.value.original.slice(draft.value.start, draft.value.end), draft.value.text) : [])
const before = computed(() => draft.value?.original.slice(Math.max(0, draft.value.start - 60), draft.value.start))
const after = computed(() => draft.value?.original.slice(draft.value.end, draft.value.end + 60))
const labels = { continue: '续写', polish: '润色', fix: '校对', summarize: '摘要' }
const statusLabel = computed(() => {
  if (stale.value) return '正文已变化，请基于当前正文重新生成'
  return { streaming: '正在生成…', ready: '审阅后即可接受', stopped: '已停止，保留了已生成内容', error: '生成未完成，请重试' }[draft.value?.status || 'ready']
})

function stop() {
  version++
  aiStore.stopGeneration()
  if (draft.value?.status === 'streaming') draft.value.status = 'stopped'
}
function reset() {
  stop()
  draft.value = null
  customOpen.value = false
  adjusting.value = false
  instruction.value = ''
  inputText.value = ''
  aiStore.error = null
  aiStore.loadChatHistory(props.bookId, props.chapterId)
}
onMounted(reset)
watch(() => [props.bookId, props.chapterId], reset)
onBeforeUnmount(stop)
function trackScroll() {
  const el = messagesRef.value
  if (el) followOutput.value = el.scrollHeight - el.scrollTop - el.clientHeight < 64
}
watch(() => [draft.value?.text, draft.value?.status, aiStore.chatMessages[aiStore.chatMessages.length - 1]?.content], () => {
  if (followOutput.value) nextTick(() => {
    const el = messagesRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

async function generate(snapshot: Draft) {
  const currentVersion = ++version
  draft.value = { ...snapshot, text: '', status: 'streaming' }
  adjusting.value = false
  showOriginal.value = false
  followOutput.value = true
  const receive = (text: string) => {
    if (currentVersion === version && draft.value) draft.value.text += text
  }
  let text: string | undefined
  if (snapshot.command === 'polish') {
    const result = await aiStore.polishDiffStream(props.bookId, snapshot.input, snapshot.selected,
      snapshot.chapterId, snapshot.instruction, receive, undefined, snapshot.model)
    if (result) { text = result.revised; if (currentVersion === version && draft.value) draft.value.truncated = result.truncated }
  } else {
    const result = await aiStore.streamWrite(props.bookId, snapshot.input, snapshot.command,
      receive, snapshot.selected, snapshot.chapterId, snapshot.model)
    text = result?.answer
  }
  if (currentVersion !== version || !draft.value) return
  if (text?.trim()) {
    draft.value.text = writingReplacement(snapshot.selected || snapshot.input, text, snapshot.command)
    draft.value.truncated ||= snapshot.command === 'fix' && Array.from(snapshot.selected || snapshot.input).length > 3000
    draft.value.status = 'ready'
  }
  else draft.value.status = 'error'
}
async function runAction(action: Action, options: { atSelection?: boolean; instruction?: string; model?: string | null } = {}) {
  if (aiStore.isLoading || !props.chapterId) return
  panelMode.value = 'write'
  if (action === 'continue' && options.atSelection) placement.value = 'cursor'
  if (action === 'custom') {
    customOpen.value = true
    await nextTick()
    instructionRef.value?.focus()
    return
  }
  if (action !== 'continue' && !targetText.value.trim()) return
  const range = writingTarget(content.value, action, props.selectionStart, props.selectionEnd,
    !!props.hasCursor && placement.value === 'cursor')
  const requestedInstruction = options.instruction ?? (customOpen.value ? instruction.value.trim() : '')
  customOpen.value = false
  await generate({ chapterId: props.chapterId, original: content.value, start: range.start, end: range.end,
    input: range.input, selected: range.selected, model: options.model === undefined ? aiStore.selectedModel : options.model, command: action,
    instruction: action === 'polish' ? requestedInstruction : '', text: '', status: 'streaming',
    description: action === 'continue' ? (range.end === content.value.length ? '插入章末' : `插入第 ${range.end} 字之后`) : targetLabel.value,
  })
}
defineExpose({ runAction })
async function retry() {
  if (!draft.value || aiStore.isLoading) return
  if (stale.value) { await runAction(draft.value.command, { instruction: draft.value.instruction, model: draft.value.model }); return }
  await generate({ ...draft.value })
}
async function adjust() {
  if (!ready.value || !draft.value || !instruction.value.trim()) return
  // Keep the original replacement range; only the last generated text becomes the refinement input.
  await generate({ ...draft.value, command: 'polish', input: draft.value.text, selected: undefined,
    instruction: instruction.value.trim(), description: draft.value.description + ' · 继续调整' })
}
function accept(insertAfter = false) {
  const result = draft.value
  if (!ready.value || !result || result.command === 'summarize') return
  let replacement = result.text
  const start = insertAfter ? result.end : result.start
  if (insertAfter) {
    replacement = (result.original[start - 1] && result.original[start - 1] !== '\n' ? '\n' : '') + replacement
      + (result.original[start] && result.original[start] !== '\n' ? '\n' : '')
  }
  emit('applyChange', { chapterId: result.chapterId, original: result.original, start, end: result.end,
    replacement, label: insertAfter || result.start === result.end ? 'AI 插入' : 'AI 修改' })
  draft.value = null
  adjusting.value = false
  instruction.value = ''
}
function discard() { draft.value = null; adjusting.value = false; instruction.value = ''; aiStore.error = null }
function openAdjustment() { adjusting.value = true; instruction.value = ''; nextTick(() => instructionRef.value?.focus()) }
async function sendChat() {
  if (!inputText.value.trim() || aiStore.isLoading) return
  const message = inputText.value.trim()
  inputText.value = ''
  followOutput.value = true
  await aiStore.streamChat(props.bookId, message, chunk => aiStore.appendToLastAssistant(chunk), content.value, props.chapterId)
}
function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing || isComposing.value) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    if (Date.now() - compositionEndedAt > 300) void sendChat()
  }
}
</script>

<template>
  <aside class="ai-panel-shell" aria-label="AI 助手">
    <header class="panel-header">
      <div><strong>AI 助手</strong><p class="muted text-xs mt-1">选中一段文字，试试润色或校对</p></div>
      <button class="icon-button" aria-label="关闭 AI 助手" @click="aiStore.closePanel()">×</button>
    </header>
    <div class="panel-settings">
      <div class="mode-tabs" role="tablist" aria-label="AI 助手模式">
        <button role="tab" :aria-selected="panelMode === 'write'" @click="panelMode = 'write'">写作</button>
        <button role="tab" :aria-selected="panelMode === 'chat'" @click="panelMode = 'chat'">问答</button>
      </div>
      <select v-model="aiStore.selectedModel" aria-label="选择 AI 模型" :disabled="aiStore.isLoading">
        <option :value="null">默认模型</option>
        <option v-for="model in MODEL_OPTIONS" :key="model.value" :value="model.value">{{ model.label }}</option>
      </select>
    </div>
    <div ref="messagesRef" class="panel-body" @scroll="trackScroll">
      <template v-if="panelMode === 'write'">
        <section class="target-card">
          <div class="flex justify-between gap-2"><strong class="text-xs">当前范围</strong><span class="muted text-xs">{{ targetLabel }}</span></div>
          <p class="target-snippet">{{ targetText.slice(0, 80) || '可从空白开始续写' }}{{ targetText.length > 80 ? '…' : '' }}</p>
        </section>
        <div class="placement-row">
          <label for="ai-placement">续写位置</label>
          <select id="ai-placement" v-model="placement" :disabled="aiStore.isLoading">
            <option value="cursor" :disabled="!props.hasCursor">{{ props.hasCursor ? (hasSelection ? '选区之后' : '光标处') : '章末（尚未定位光标）' }}</option>
            <option value="end">章末</option>
          </select>
        </div>
        <div class="actions-grid">
          <button class="ai-action primary-action" :disabled="aiStore.isLoading || !props.chapterId" @click="runAction('continue')">续写<span>{{ placement === 'cursor' && props.hasCursor ? '从当前位置接着写' : '接在章末' }}</span></button>
          <button class="ai-action" :disabled="aiStore.isLoading || !targetText.trim()" @click="runAction('polish')">润色<span>保留原意，改善表达</span></button>
          <button class="ai-action" :disabled="aiStore.isLoading || !targetText.trim()" @click="runAction('fix')">校对<span>错字、标点与语病</span></button>
          <button class="ai-action" :disabled="aiStore.isLoading || !targetText.trim()" @click="runAction('custom')">自定义修改<span>按你的要求调整</span></button>
        </div>
        <button class="text-button" :disabled="aiStore.isLoading || !targetText.trim()" @click="runAction('summarize')">生成当前范围的摘要</button>
        <section v-if="customOpen" class="result-card">
          <label class="text-sm font-semibold" for="custom-instruction">你想怎样修改？</label>
          <textarea id="custom-instruction" ref="instructionRef" v-model="instruction" rows="3" placeholder="例如：增强画面感，保留人物语气" />
          <button class="btn-primary w-full text-xs" :disabled="aiStore.isLoading || !instruction.trim()" @click="runAction('polish')">生成修改</button>
        </section>
        <section v-if="draft" class="result-card" aria-label="AI 审阅结果">
          <div class="flex justify-between items-start gap-2"><div><strong class="text-sm">{{ labels[draft.command] }}结果</strong><p class="muted text-xs mt-1">{{ draft.description }}</p></div><span class="muted text-xs">{{ draft.text.length }} 字</span></div>
          <p class="result-status" role="status">{{ statusLabel }}</p>
          <p v-if="draft.truncated" class="muted text-xs">本次仅修改前 3000 字，其余原文已保留。</p>
          <div v-if="draft.status === 'ready' && draft.command !== 'summarize'" class="diff-preview" aria-label="局部修改对比">
            <p v-if="before" class="context-text">{{ draft.start > 60 ? '…' : '' }}{{ before }}</p>
            <div class="diff-content"><template v-for="(segment, index) in segments" :key="index"><del v-if="segment.type === 'delete'">{{ segment.text }}</del><ins v-else-if="segment.type === 'insert'">{{ segment.text }}</ins><span v-else>{{ segment.text }}</span></template></div>
            <p v-if="after" class="context-text">{{ after }}{{ draft.original.length > draft.end + 60 ? '…' : '' }}</p>
          </div>
          <div v-else class="draft-text">{{ draft.text || '正在组织内容…' }}</div>
          <p v-if="draft.status === 'ready' && draft.command !== 'summarize'" class="muted text-xs">删除线为原文，绿色下划线为新增内容</p>
          <template v-if="draft.status !== 'streaming'">
            <div class="review-actions secondary-actions">
              <button class="text-button" :disabled="aiStore.isLoading" @click="retry">{{ stale ? '基于当前正文重新生成' : '重新生成' }}</button>
              <button v-if="draft.command !== 'summarize'" class="text-button" :disabled="!ready" @click="openAdjustment">再改一下</button>
              <button class="text-button" @click="discard">丢弃</button>
            </div>
            <template v-if="adjusting">
              <label class="text-xs" for="adjust-instruction">在这份结果上继续调整</label>
              <textarea id="adjust-instruction" ref="instructionRef" v-model="instruction" rows="2" placeholder="例如：再简洁一点，结尾保留悬念" />
              <button class="btn-primary w-full text-xs" :disabled="!ready || !instruction.trim()" @click="adjust">调整这份结果</button>
            </template>
            <button class="text-button" @click="showOriginal = !showOriginal">{{ showOriginal ? '收起原文与结果' : '展开原文与结果' }}</button>
            <div v-if="showOriginal" class="space-y-2"><div class="draft-text"><strong>原文</strong><p>{{ draft.original.slice(draft.start, draft.end) || '（插入位置）' }}</p></div><div class="draft-text"><strong>结果</strong><p>{{ draft.text }}</p></div></div>
          </template>
        </section>
      </template>
      <template v-else>
        <p v-if="!aiStore.chatMessages.length" class="muted text-sm py-6">一起讨论情节、人物和设定。回答不会自动写入正文。</p>
        <div v-for="(message, index) in aiStore.chatMessages" :key="index" class="chat-message" :class="{ 'user-message': message.role === 'user' }">{{ message.content || (aiStore.isLoading ? 'AI 正在思考…' : '未生成回答') }}</div>
      </template>
      <p v-if="aiStore.error" class="error-message" role="alert">{{ aiStore.error }}</p>
    </div>
    <div v-if="aiStore.isLoading" class="stop-row"><span role="status">正在生成，正文仍可编辑</span><button class="btn-secondary text-xs" @click="stop">停止生成</button></div>
    <footer v-if="panelMode === 'chat'" class="panel-footer">
      <textarea v-model="inputText" rows="2" aria-label="向 AI 提问" placeholder="Enter 发送，Shift+Enter 换行" @keydown="handleKeydown" @compositionstart="isComposing = true" @compositionend="isComposing = false; compositionEndedAt = Date.now()" />
      <div class="flex justify-between items-center"><button class="text-button" @click="stop(); aiStore.clearChat()">清空问答</button><button class="btn-primary text-xs" :disabled="aiStore.isLoading || !inputText.trim()" @click="sendChat">发送</button></div>
    </footer>
    <footer v-else class="panel-footer">
      <div v-if="draft && draft.command !== 'summarize' && draft.status !== 'streaming'" class="review-actions">
        <button class="btn-primary text-xs flex-1" :disabled="!ready || aiStore.isLoading" @click="accept()">{{ draft.start === draft.end ? '插入此处' : '接受修改' }}</button>
        <button v-if="draft.start !== draft.end" class="btn-secondary text-xs" :disabled="!ready || aiStore.isLoading" @click="accept(true)">插入原文后</button>
      </div>
      <p v-else class="muted text-xs">审阅后接受，写回后可撤销。</p>
    </footer>
  </aside>
</template>

<style scoped>
.ai-panel-shell { display:flex; flex-direction:column; height:100%; flex-shrink:0; overflow:hidden; border-left:1px solid var(--border-clr); background:var(--surface); color:var(--text-primary); }
.panel-header { display:flex; align-items:center; justify-content:space-between; padding:16px; gap:8px; border-bottom:1px solid var(--border-clr); }
.icon-button { min-width:36px; min-height:36px; border-radius:8px; font-size:24px; color:var(--text-muted); }
.icon-button:hover { background:var(--surface-hover); }
.panel-settings { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border-clr); }
.mode-tabs { display:flex; gap:4px; flex:1; }
.mode-tabs button { min-height:36px; padding:6px 12px; border-radius:8px; font-size:12px; }
.mode-tabs button[aria-selected=true] { background:var(--brand-softer); color:var(--brand-hover); font-weight:600; }
select { max-width:145px; min-width:0; min-height:34px; border:1px solid var(--border-clr); border-radius:8px; padding:4px 6px; font-size:11px; background:var(--surface-secondary); color:var(--text-secondary); }
.panel-body { flex:1; overflow:auto; min-height:0; padding:14px; display:flex; flex-direction:column; gap:12px; }
.muted { color:var(--text-muted); }
.target-card,.result-card { border:1px solid var(--border-clr); border-radius:12px; padding:12px; background:var(--surface-secondary); }
.target-snippet { margin-top:8px; font-size:12px; line-height:1.7; color:var(--text-secondary); overflow-wrap:anywhere; }
.placement-row { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; }
.actions-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.ai-action { min-height:60px; display:flex; flex-direction:column; align-items:flex-start; gap:4px; border:1px solid var(--border-clr); border-radius:10px; padding:10px; font-size:13px; text-align:left; background:var(--surface); }
.ai-action span { color:var(--text-muted); font-size:11px; }
.ai-action:hover:not(:disabled),.primary-action { background:var(--brand-softer); border-color:var(--brand); }
button:disabled { opacity:.45; cursor:not-allowed; }
button:focus-visible,select:focus-visible,textarea:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
.text-button { min-height:32px; font-size:12px; color:var(--brand-hover); text-align:left; }
.result-card { display:flex; flex-direction:column; gap:10px; }
.result-status { font-size:12px; color:var(--text-secondary); }
.diff-preview,.draft-text { border-radius:8px; padding:10px; background:var(--surface); font-size:14px; line-height:1.9; white-space:pre-wrap; overflow-wrap:anywhere; }
.context-text { color:var(--text-muted); font-size:12px; }
.diff-content { border-block:1px dashed var(--border-clr); margin-block:8px; padding-block:8px; }
del { background:#f3dcd5; color:#913c28; text-decoration-thickness:2px; }
ins { background:#dfe8dc; color:#305e3b; text-decoration:underline; text-underline-offset:3px; }
.review-actions { display:flex; gap:6px; flex-wrap:wrap; }
.review-actions button { min-height:36px; padding:6px 10px; }
.secondary-actions { justify-content:space-between; gap:4px; }
.secondary-actions button { padding-inline:0; }
textarea { width:100%; padding:10px; border:1px solid var(--border-clr); border-radius:8px; font-size:13px; resize:vertical; background:var(--surface); color:var(--text-primary); }
.panel-footer { padding:12px 14px max(12px,env(safe-area-inset-bottom)); border-top:1px solid var(--border-clr); }
.stop-row { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px 14px; border-top:1px solid var(--border-clr); font-size:11px; color:var(--text-secondary); }
.chat-message { align-self:flex-start; max-width:95%; white-space:pre-wrap; overflow-wrap:anywhere; border-radius:12px; padding:12px; font-size:14px; background:var(--surface-secondary); }
.user-message { align-self:flex-end; background:var(--ink); color:var(--ink-text); }
.error-message { border-radius:8px; padding:10px; background:#f9e3dd; color:#913c28; font-size:13px; }
@media (max-width:768px) { .ai-panel-shell { position:fixed; inset:0 0 0 auto; z-index:60; width:min(100vw,420px)!important; box-shadow:var(--shadow-lift); } .icon-button,.review-actions button,.text-button { min-height:44px; } .icon-button { min-width:44px; } textarea { font-size:16px; } }
</style>
