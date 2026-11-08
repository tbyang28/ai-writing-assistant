<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { isScenePlan, SceneStreamError, streamSceneDraft, streamScenePlan, type ScenePlan, type SceneProgress, type SceneResult, type SceneStage } from '@/api/scene'
import type { AiChangeProposal } from '@/utils/aiChange'

const props = defineProps<{
  bookId: string
  chapterId?: string
  chapterContent?: string
  model?: string | null
  blocked?: boolean
  modelUnavailable?: boolean
}>()
const emit = defineEmits<{ busy: [value: boolean]; applyChange: [proposal: AiChangeProposal] }>()
const auth = useAuthStore()
const id = useId()
const intent = ref('')
const plan = ref<ScenePlan | null>(null)
const planCurrent = ref(false)
const autoRepair = ref(false)
const result = ref<SceneResult | null>(null)
const resultSnapshot = ref<{ chapterId: string; original: string; version: number } | null>(null)
const initialDraft = ref(false)
const partial = ref('')
const error = ref('')
const notice = ref('')
const stage = ref<SceneStage>('context')
const version = ref(0)
const active = shallowRef<{ controller: AbortController; version: number; kind: 'plan' | 'draft' } | null>(null)
const running = computed(() => Boolean(active.value))
const unavailable = computed(() => Boolean(props.blocked || props.modelUnavailable))
const content = computed(() => props.chapterContent || '')
const resultStale = computed(() => Boolean(resultSnapshot.value && (
  resultSnapshot.value.version !== version.value || resultSnapshot.value.original !== content.value
  || resultSnapshot.value.chapterId !== props.chapterId || !planCurrent.value
)))
const inputError = computed(() => content.value.length > 60_000 ? '当前章节超过 60000 字符，请缩短后再生成。'
  : intent.value.trim().length > 1200 ? '场景意图最多 1200 字符。' : '')
const planValid = computed(() => isScenePlan(plan.value))
const canPlan = computed(() => !running.value && !unavailable.value && Boolean(props.chapterId && intent.value.trim()) && !inputError.value)
const canGenerate = computed(() => canPlan.value && planCurrent.value && planValid.value)
const canPreview = computed(() => !running.value && !unavailable.value && Boolean(result.value && resultSnapshot.value) && !resultStale.value)
const phaseLabels: Record<SceneStage, string> = { context: '正在读取作品上下文', plan: '正在整理场景目标', draft: '正在生成初稿', review: '正在审阅初稿', repair: '正在进行一次局部修订' }
const kindLabels = { goal: '场景目标', revelation: '信息揭示', pov: '叙述视角', continuity: '设定连续性', style: '表达与节奏' }

watch(running, value => emit('busy', value), { flush: 'sync', immediate: true })
function stop(message = '已停止生成；部分内容不可使用。') {
  const run = active.value
  if (!run) return
  active.value = null
  run.controller.abort()
  partial.value = ''
  notice.value = message
}
function invalidate() {
  // Keep staleness irreversible even if the author restores the previous inputs.
  version.value += 1
  stop('输入或上下文已变化，已停止生成，请重新生成。')
}
watch(() => [props.bookId, props.chapterId, auth.user?.id, auth.token], () => {
  invalidate()
  intent.value = ''
  plan.value = null
  planCurrent.value = false
  autoRepair.value = false
  result.value = null
  resultSnapshot.value = null
  partial.value = ''
  error.value = ''
  notice.value = ''
}, { flush: 'sync' })
watch(() => [content.value, props.model, intent.value], () => {
  planCurrent.value = false
  invalidate()
}, { flush: 'sync' })
watch([plan, autoRepair], invalidate, { deep: true, flush: 'sync' })
watch(() => props.modelUnavailable, value => { if (value) invalidate() }, { flush: 'sync' })
onBeforeUnmount(() => stop())

async function run(kind: 'plan' | 'draft') {
  if (kind === 'plan' ? !canPlan.value : !canGenerate.value) return
  result.value = null
  resultSnapshot.value = null
  error.value = ''
  notice.value = ''
  partial.value = ''
  initialDraft.value = false
  stage.value = 'context'
  const request = { book_id: props.bookId, chapter_id: props.chapterId, content: content.value, intent: intent.value.trim(), model: props.model ?? null }
  const current = { controller: new AbortController(), version: version.value, kind }
  active.value = current
  const isCurrent = () => active.value === current && version.value === current.version && !current.controller.signal.aborted
  const progress = (event: SceneProgress) => {
    if (!isCurrent()) return
    if (event.type === 'stage') stage.value = event.data.stage
    else partial.value = (partial.value + event.data.text).slice(0, 60_000)
  }
  try {
    if (kind === 'plan') {
      planCurrent.value = false
      const response = await streamScenePlan(request, current.controller.signal, progress)
      if (!isCurrent()) return
      active.value = null
      plan.value = { ...response.plan }
      planCurrent.value = true
      notice.value = '目标已整理，可编辑后生成并审阅。'
    } else {
      const response = await streamSceneDraft({ ...request, plan: { ...plan.value! }, auto_repair: autoRepair.value }, current.controller.signal, progress)
      if (!isCurrent()) return
      result.value = response
      resultSnapshot.value = { chapterId: request.chapter_id!, original: request.content, version: version.value }
      notice.value = '生成与审阅已完成，尚未写入正文。'
    }
  } catch (failure) {
    if (!isCurrent()) return
    error.value = failure instanceof SceneStreamError ? failure.message : '场景请求失败，请重新生成。'
    result.value = null
    resultSnapshot.value = null
  } finally {
    if (active.value === current) {
      active.value = null
      partial.value = ''
    }
  }
}
function preview() {
  if (!canPreview.value || !result.value || !resultSnapshot.value) return
  const snapshot = resultSnapshot.value
  const text = initialDraft.value ? result.value.draft : result.value.revised
  const separator = snapshot.original && !snapshot.original.endsWith('\n\n') ? (snapshot.original.endsWith('\n') ? '\n' : '\n\n') : ''
  emit('applyChange', {
    chapterId: snapshot.chapterId, original: snapshot.original, start: snapshot.original.length, end: snapshot.original.length,
    replacement: separator + text, label: initialDraft.value ? '场景初稿追加预览' : '场景目标续写追加预览',
  })
}
</script>

<template>
  <section class="scene-panel rounded-xl border p-3.5 space-y-3" :aria-labelledby="`${id}-title`" :aria-busy="running">
    <div>
      <h3 :id="`${id}-title`" class="text-sm font-semibold">场景目标续写</h3>
      <p class="secondary text-xs leading-5 mt-1">先定目标，再生成并审阅。结果需预览确认后追加到章末。</p>
    </div>
    <div>
      <label :for="`${id}-intent`" class="block text-xs font-medium mb-1.5">这场戏想写什么？</label>
      <textarea :id="`${id}-intent`" v-model="intent" rows="3" maxlength="1200" :aria-describedby="`${id}-hint`" placeholder="例如：主角在雨夜试探旧友，发现线索，但暂不揭露来信人的身份。" />
      <p :id="`${id}-hint`" class="secondary text-xs leading-5 mt-1">{{ intent.length }}/1200 · 基于章末与相关作品资料</p>
    </div>
    <p v-if="!props.chapterId" class="secondary text-xs" role="status">请先选择一个章节。</p>
    <p v-if="inputError" class="text-xs leading-5" role="alert">{{ inputError }}</p>
    <button type="button" class="btn-secondary scene-action w-full" :disabled="!canPlan" @click="run('plan')">整理场景目标</button>

    <fieldset v-if="plan" class="space-y-3 min-w-0">
      <legend class="text-xs font-semibold mb-2">可编辑的场景目标</legend>
      <div>
        <label :for="`${id}-goal`" class="field-label">作者目标</label>
        <textarea :id="`${id}-goal`" v-model="plan.goal" rows="2" maxlength="600" required />
      </div>
      <div>
        <label :for="`${id}-withheld`" class="field-label">暂不揭露的信息（可留空）</label>
        <textarea :id="`${id}-withheld`" v-model="plan.withheld" rows="2" maxlength="600" />
      </div>
      <div>
        <label :for="`${id}-pov`" class="field-label">叙述视角</label>
        <input :id="`${id}-pov`" v-model="plan.pov" type="text" maxlength="300" required />
      </div>
      <div>
        <label :for="`${id}-ending`" class="field-label">场景终点（可留空）</label>
        <textarea :id="`${id}-ending`" v-model="plan.ending" rows="2" maxlength="400" />
      </div>
      <div>
        <label :for="`${id}-length`" class="field-label">目标字数（200–1600）</label>
        <input :id="`${id}-length`" v-model.number="plan.targetChars" type="number" min="200" max="1600" step="1" required />
      </div>
      <p v-if="!planCurrent" class="secondary text-xs leading-5" role="status">意图、正文或模型已变化，请重新整理场景目标。</p>
      <p v-else-if="!planValid" class="text-xs leading-5" role="alert">请填写作者目标、叙述视角，并将目标字数设为 200–1600 的整数。</p>
      <label class="repair-option flex items-start gap-2 text-xs leading-5 cursor-pointer">
        <input v-model="autoRepair" type="checkbox" class="mt-1 shrink-0" />
        <span>允许至多一次局部修订<span class="block secondary">默认关闭；只修订可处理的发现，修订后不会再次审阅。</span></span>
      </label>
      <button type="button" class="btn-primary scene-action w-full" :disabled="!canGenerate" @click="run('draft')">生成并审阅</button>
    </fieldset>

    <div v-if="running" class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="secondary text-xs leading-5" role="status" aria-live="polite">{{ phaseLabels[stage] }}…</p>
        <button type="button" class="btn-secondary scene-action" @click="stop()">停止生成</button>
      </div>
      <div v-if="partial" class="draft-text rounded-lg p-3 text-sm leading-6 font-serif whitespace-pre-wrap break-words max-h-60 overflow-y-auto" aria-label="生成中的初稿（不可应用）">{{ partial }}</div>
    </div>
    <p v-if="error" role="alert" class="text-xs leading-5">{{ error }}</p>
    <p v-else-if="notice" role="status" class="secondary text-xs leading-5">{{ notice }}</p>

    <div v-if="result" class="space-y-3">
      <div class="flex flex-wrap gap-2" role="group" aria-label="查看场景版本">
        <button type="button" class="btn-secondary scene-action" :aria-pressed="initialDraft" @click="initialDraft = true">初稿</button>
        <button type="button" class="btn-secondary scene-action" :aria-pressed="!initialDraft" @click="initialDraft = false">{{ result.repairApplied ? '修订稿' : '最终稿' }}</button>
      </div>
      <p class="secondary text-xs leading-5">{{ initialDraft ? '生成初稿' : result.repairApplied ? '已作一次局部修订；修订稿尚未再次审阅。' : '未进行局部修订，最终稿与初稿相同。' }}</p>
      <div class="draft-text rounded-lg p-3 text-sm leading-6 font-serif whitespace-pre-wrap break-words max-h-80 overflow-y-auto" aria-label="场景结果正文">{{ initialDraft ? result.draft : result.revised }}</div>
      <p class="secondary text-xs leading-5">以下为 AI 对初稿的审阅建议，不是事实证明，也不能保证发现所有问题。请结合原文自行判断。</p>
      <p v-if="!result.findings.length" class="secondary text-xs leading-5">本次未报告可定位的问题，仍请自行核对。</p>
      <article v-for="(finding, index) in result.findings" :key="finding.id + index" class="finding rounded-lg border p-3 space-y-2 text-xs leading-5">
        <div class="flex flex-wrap items-center justify-between gap-2 font-semibold">
          <span>{{ kindLabels[finding.kind] }}</span>
          <span>{{ finding.severity === 'conflict' ? '可能冲突' : '建议' }} · {{ finding.repairable ? '可局部修订' : '需作者判断' }}</span>
        </div>
        <p class="whitespace-pre-wrap break-words"><span class="font-semibold">对应约束：</span>{{ finding.constraint }}</p>
        <p class="secondary break-words">约束来源：{{ finding.constraintId }} · 初稿位置 {{ finding.start }}–{{ finding.end }}</p>
        <blockquote class="draft-text rounded p-2 whitespace-pre-wrap break-words" aria-label="初稿原句">{{ finding.quote }}</blockquote>
        <p class="whitespace-pre-wrap break-words"><span class="font-semibold">原因：</span>{{ finding.reason }}</p>
        <p class="whitespace-pre-wrap break-words"><span class="font-semibold">建议：</span>{{ finding.suggestion }}</p>
      </article>
      <ul v-if="result.warnings.length" class="secondary text-xs leading-5 space-y-1 list-disc pl-4" aria-label="场景生成提示">
        <li v-for="(warning, index) in result.warnings" :key="index" class="whitespace-pre-wrap break-words">{{ warning }}</li>
      </ul>
      <p v-if="resultStale" class="text-xs leading-5" role="status">输入或上下文已变化，这份结果已过期，请重新生成。</p>
      <button type="button" class="btn-primary scene-action w-full" :disabled="!canPreview" @click="preview">预览追加到章末</button>
    </div>
  </section>
</template>

<style scoped>
.scene-panel { color: var(--text-primary); background: var(--surface-secondary); border-color: var(--border-clr); }
.secondary { color: var(--text-secondary); }
.field-label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 6px; }
textarea, input:not([type="checkbox"]) { display: block; width: 100%; min-width: 0; min-height: 44px; padding: 10px; border: 1px solid var(--border-clr); border-radius: 8px; background: var(--surface); color: var(--text-primary); font-size: 14px; line-height: 1.5; }
textarea { resize: vertical; max-height: 240px; }
input[type="checkbox"] { accent-color: var(--brand); width: 18px; height: 18px; }
.repair-option { min-height: 44px; padding-block: 4px; }
.scene-action { min-height: 44px; padding: 8px 12px; font-size: 12px; }
button[aria-pressed="true"] { border-color: var(--brand); background: var(--brand-softer); color: var(--text-primary); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.draft-text { background: var(--surface); }
.finding { border-color: var(--border-clr); }
</style>
