<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ProposalState } from '@/stores/agent'

const props = defineProps<{ item: ProposalState }>()
const emit = defineEmits<{ action: [id: string, action: 'confirm' | 'cancel'] }>()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
const expired = computed(() => props.item.expired || (!props.item.retryAction && Date.parse(props.item.proposal.expiresAt) <= now.value))
const pending = computed(() => props.item.proposal.status === 'pending')
const statusLabel = computed(() => {
  if (props.item.proposal.status === 'confirmed') return props.item.proposal.result?.created === false ? '已确认 · 沿用已有记录' : '已确认 · 已保存'
  if (props.item.proposal.status === 'cancelled') return '已取消 · 未保存'
  if (expired.value) return '提案已过期'
  if (props.item.retryAction) return '操作结果待核实'
  return '尚未保存'
})
const labels: Record<string, string> = { name: '姓名', role: '角色', bio: '人物简介', title: '标题', content: '内容', tags: '标签' }
function format(value: unknown) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
</script>

<template>
  <section class="proposal-card" :aria-label="item.proposal.tool === 'save_character' ? '人物保存提案' : '灵感保存提案'">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-sm font-semibold">{{ item.proposal.tool === 'save_character' ? '保存人物到设定库' : '保存灵感到灵感库' }}</h3>
      <span class="text-xs font-medium" role="status">{{ statusLabel }}</span>
    </div>
    <p v-if="pending && !expired && !item.retryAction" class="text-xs leading-5 mt-2 secondary">确认后才会保存以下内容。请先核对参数。</p>
    <dl class="mt-3 space-y-2.5">
      <div v-for="(value, key) in item.proposal.args" :key="key">
        <dt class="text-xs font-medium secondary">{{ labels[key] || key }}</dt>
        <dd class="text-sm leading-6 whitespace-pre-wrap break-words mt-0.5">{{ format(value) }}</dd>
      </div>
    </dl>
    <details class="mt-3 text-xs secondary">
      <summary class="cursor-pointer py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand)]">提案信息与有效期</summary>
      <dl class="space-y-1.5 break-all leading-5">
        <div><dt class="inline">提案 ID：</dt><dd class="inline">{{ item.proposal.id }}</dd></div>
        <div><dt class="inline">作品 ID：</dt><dd class="inline">{{ item.proposal.bookId }}</dd></div>
        <div><dt class="inline">有效期至：</dt><dd class="inline">{{ new Date(item.proposal.expiresAt).toLocaleString() }}</dd></div>
        <div><dt class="inline">摘要：</dt><dd class="inline">{{ item.proposal.digest }}</dd></div>
      </dl>
    </details>
    <div v-if="item.proposal.status === 'confirmed' && item.proposal.result" class="mt-2 text-xs leading-5">
      <p>{{ item.proposal.result.created === false ? '已找到同名人物，返回已有记录，没有重复新增。' : '保存成功，可以在对应设定库查看。' }}</p>
      <details class="mt-1 secondary"><summary class="cursor-pointer py-2">查看保存结果</summary><pre class="whitespace-pre-wrap break-all text-xs">{{ JSON.stringify(item.proposal.result, null, 2) }}</pre></details>
    </div>
    <p v-if="pending && expired" class="mt-3 text-xs leading-5 secondary">{{ item.retryAction ? '服务端已确认提案过期，无法继续此操作。' : '有效期已结束；如仍需保存，请让 Agent 生成新提案。' }}</p>
    <div v-if="item.error" class="mt-3 text-xs leading-5" role="alert">
      <p>{{ item.error }}</p>
      <p v-if="!expired" class="secondary mt-1">重试会沿用同一提案核实结果，不会重复新增。核实前请勿重新生成相同保存请求。</p>
    </div>
    <div v-if="pending && !expired" class="flex flex-wrap gap-2 mt-3">
      <template v-if="item.retryAction">
        <button type="button" class="btn-primary proposal-button" :disabled="Boolean(item.busy)" @click="emit('action', item.proposal.id, item.retryAction)">{{ item.busy ? '正在核实…' : item.retryAction === 'confirm' ? '重试确认保存' : '重试取消提案' }}</button>
      </template>
      <template v-else>
        <button type="button" class="btn-primary proposal-button" :disabled="Boolean(item.busy)" @click="emit('action', item.proposal.id, 'confirm')">{{ item.busy === 'confirm' ? '正在保存…' : '确认保存' }}</button>
        <button type="button" class="btn-secondary proposal-button" :disabled="Boolean(item.busy)" @click="emit('action', item.proposal.id, 'cancel')">{{ item.busy === 'cancel' ? '正在取消…' : '取消提案' }}</button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.proposal-card { min-width: 0; border: 1px solid var(--border-clr); border-radius: 12px; padding: 14px; background: var(--surface); color: var(--text-primary); }
.secondary { color: var(--text-secondary); }
.proposal-button { min-height: 44px; padding: 8px 12px; font-size: 12px; }
button:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
button:disabled { cursor: not-allowed; opacity: 0.55; }
</style>
