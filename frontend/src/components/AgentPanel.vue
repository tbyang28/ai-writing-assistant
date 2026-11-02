<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useAgentStore, type AgentTurn } from '@/stores/agent'
import AgentProposalCard from './AgentProposalCard.vue'
import { useLocalProvidersStore } from '@/stores/localProviders'

const props = defineProps<{ bookId: string; chapterId?: string; chapterContent?: string; model?: string | null; blocked?: boolean }>()
const emit = defineEmits<{ review: [] }>()
const agent = useAgentStore()
const input = ref('')
const composing = ref(false)
const scrollRef = ref<HTMLElement | null>(null)
let followOutput = true
const localCatalog = useLocalProvidersStore()
const localStatus = computed(() => localCatalog.modelStatus(props.model))
const busy = computed(() => agent.isLoading || props.blocked || localStatus.value?.unavailable)
const toolNames: Record<string, string> = {
  search_story: '检索作品内容', get_characters: '读取人物设定', get_outline: '读取大纲',
  get_recent_chapters: '读取最近章节', get_chapter: '读取章节', list_chapters: '查看章节目录',
  get_character_relations: '读取人物关系', list_inspirations: '读取灵感',
  save_character: '准备人物保存提案', save_inspiration: '准备灵感保存提案', diff_edit: '生成正文审阅建议',
}
const toolStatus = { running: '进行中', completed: '已完成', failed: '失败', aborted: '已停止' }
watch(() => [props.bookId, props.chapterId], () => {
  agent.setContext(props.bookId, props.chapterId)
  input.value = ''
  followOutput = true
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => agent.cancelGeneration())
function trackScroll() {
  const element = scrollRef.value
  if (element) followOutput = element.scrollHeight - element.scrollTop - element.clientHeight < 64
}
watch(() => {
  const turn = agent.turns[agent.turns.length - 1]
  return [agent.turns.length, turn?.answer, turn?.status, turn?.steps.length, turn?.proposalIds.length,
    turn?.tools.map(tool => `${tool.id}:${tool.status}`).join('|')]
}, async () => {
  if (!followOutput) return
  await nextTick()
  if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight
})
async function send(message = input.value) {
  if (busy.value || !message.trim()) return
  input.value = ''
  followOutput = true
  await agent.sendMessage(props.bookId, message, props.chapterContent, props.chapterId, props.model)
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value || event.keyCode === 229) return
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
}
function retry(turn: AgentTurn) {
  if (!turn.proposalIds.length) void send(turn.question)
}
</script>

<template>
  <div class="agent-panel flex flex-col min-h-0 flex-1">
    <div ref="scrollRef" class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4" @scroll="trackScroll">
      <div class="agent-note rounded-xl border p-3 text-xs leading-5">
        <p class="font-semibold">Agent 会按需检索作品、整理人物和灵感</p>
        <p class="mt-1">人物和灵感先生成提案，确认前尚未保存。停止生成不会取消已收到的提案。</p>
        <p class="mt-1">正文修改仍需通过写作工具审阅后写回。</p>
        <button type="button" class="review-link mt-1 text-xs underline underline-offset-4" @click="emit('review')">前往正文审阅</button>
      </div>
      <p v-if="localStatus?.unavailable" class="agent-note rounded-xl border p-3 text-xs leading-5" role="status">{{ localStatus.message }}</p>
      <p v-else-if="localStatus && !localStatus.tools" class="agent-note rounded-xl border p-3 text-xs leading-5" role="status">此本地模型不支持工具调用，服务端会自动禁用工具。Agent 可基于已提供的上下文回答，无法检索作品或生成工具提案。需要这些能力时，请手动选择支持工具的模型。</p>
      <p v-if="!agent.turns.length" class="text-sm leading-6 secondary py-4">例如：检查主角的设定是否矛盾，并整理一条后续情节灵感。</p>
      <article v-for="turn in agent.turns" :key="turn.id" class="space-y-3" aria-label="Agent 对话">
        <div class="text-right"><div class="question inline-block rounded-2xl rounded-tr-md px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words max-w-[95%]">{{ turn.question }}</div></div>
        <details v-if="turn.steps.length || turn.tools.length" class="agent-note rounded-xl border p-3" open>
          <summary class="text-xs font-semibold cursor-pointer py-1">工具进度 · {{ turn.tools.filter(tool => tool.status === 'completed').length }}/{{ turn.tools.length }} 已完成</summary>
          <p v-if="turn.steps.length" class="text-xs leading-5 secondary mt-2 break-words">第 {{ turn.steps[turn.steps.length - 1].round }} 轮 · {{ turn.steps[turn.steps.length - 1].thought || '正在规划下一步' }}</p>
          <ol class="mt-2 space-y-2">
            <li v-for="tool in turn.tools" :key="tool.id" class="text-xs leading-5">
              <div class="flex items-start justify-between gap-2"><span class="break-words">{{ toolNames[tool.name] || tool.name }}</span><span class="shrink-0 secondary">{{ toolStatus[tool.status] }}</span></div>
              <details v-if="tool.args || tool.preview" class="mt-1 secondary">
                <summary class="cursor-pointer py-1">查看调用详情</summary>
                <pre v-if="tool.args" class="whitespace-pre-wrap break-all text-xs">{{ JSON.stringify(tool.args, null, 2) }}</pre>
                <p v-if="tool.preview" class="mt-1 whitespace-pre-wrap break-words">{{ tool.preview }}</p>
              </details>
            </li>
          </ol>
        </details>
        <div v-if="turn.answer" class="answer rounded-2xl rounded-tl-md px-3.5 py-2.5 text-sm leading-6 whitespace-pre-wrap break-words">{{ turn.answer }}</div>
        <template v-for="id in turn.proposalIds" :key="id">
          <AgentProposalCard v-if="agent.proposals[id]" :item="agent.proposals[id]" @action="agent.resolveProposal" />
        </template>
        <p v-if="turn.status === 'running'" class="text-xs secondary" role="status">{{ turn.tools.some(tool => tool.status === 'running') ? 'Agent 正在使用工具…' : turn.answer ? '正在生成回答…' : 'Agent 正在思考…' }}</p>
        <p v-else-if="turn.status === 'cancelled'" class="text-xs secondary" role="status">已停止生成，已收到的内容和提案已保留。</p>
        <div v-else-if="turn.error" class="agent-note rounded-xl border p-3 text-xs leading-5" role="alert">
          <p>{{ turn.error }}</p>
          <button v-if="!turn.proposalIds.length" type="button" class="btn-secondary action-button mt-2" :disabled="busy" @click="retry(turn)">重试这个问题</button>
          <p v-else class="secondary mt-1">已收到的提案仍可处理；请先核对提案，避免重复发起相同保存请求。</p>
        </div>
      </article>
    </div>
    <form class="shrink-0 border-t p-3.5" :style="{ borderColor: 'var(--border-clr)' }" @submit.prevent="send()">
      <label for="agent-message" class="block text-xs font-medium mb-2 secondary">交给 Agent 的任务</label>
      <div class="agent-note rounded-xl border">
        <textarea id="agent-message" v-model="input" rows="2" placeholder="描述需要检索、整理或保存的内容" class="w-full text-sm px-3 py-2.5 resize-y bg-transparent" :style="{ color: 'var(--text-primary)' }" @keydown="keydown" @compositionstart="composing = true" @compositionend="composing = false"></textarea>
        <div class="flex flex-wrap justify-between items-center gap-2 px-3 pb-2.5">
          <span class="text-xs secondary">Enter 发送 · Shift+Enter 换行</span>
          <button v-if="agent.isLoading" type="button" class="btn-secondary action-button" @click="agent.cancelGeneration()">停止生成</button>
          <button v-else type="submit" class="btn-primary action-button" :disabled="busy || !input.trim()">发送任务</button>
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.agent-panel { color: var(--text-primary); }
.agent-note { border-color: var(--border-clr); background: var(--surface-secondary); }
.secondary { color: var(--text-secondary); }
.question { background: var(--ink); color: var(--ink-text); }
.answer { background: var(--surface-secondary); }
.action-button { min-height: 44px; padding: 8px 12px; font-size: 12px; }
.review-link { color: var(--brand-hover); min-height: 44px; text-align: left; }
button:focus-visible, summary:focus-visible, textarea:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
button:disabled { cursor: not-allowed; opacity: 0.55; }
textarea { min-height: 64px; max-height: 240px; border: 0; border-radius: 12px; }
</style>
