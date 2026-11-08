import { api } from '@/api'

export interface ScenePlan {
  goal: string
  withheld: string
  pov: string
  ending: string
  targetChars: number
}

export interface SceneRequest {
  book_id: string
  chapter_id?: string | null
  content: string
  intent: string
  model?: string | null
}

export interface SceneFinding {
  id: string
  kind: 'goal' | 'revelation' | 'pov' | 'continuity' | 'style'
  severity: 'conflict' | 'suggestion'
  constraintId: string
  constraint: string
  quote: string
  start: number
  end: number
  reason: string
  suggestion: string
  repairable: boolean
}

export interface SceneResult {
  plan: ScenePlan
  draft: string
  revised: string
  findings: SceneFinding[]
  repairApplied: boolean
  warnings: string[]
  metrics: {
    durationMs: number
    requestCount: number
    attemptCount: number
    usage: { status: string; knownInputTokens: number; knownOutputTokens: number }
  }
}

export type SceneStage = 'context' | 'plan' | 'draft' | 'review' | 'repair'
export type SceneProgress = { type: 'stage'; data: { stage: SceneStage } } | { type: 'token'; data: { text: string } }
export class SceneStreamError extends Error {}

const FORMAT_ERROR = '场景响应格式异常，请重试；部分内容不可使用。'
const INCOMPLETE_ERROR = '场景连接中断，未收到完整结果；请重新生成。'
const MAX_FRAME = 1_000_000
const MAX_STREAM = 4_000_000
const SAFE_ERRORS = new Map([
  ['场景任务返回的结构无法解析，请重试；未生成可应用结果', FORMAT_ERROR],
  ['场景任务超时，请缩小目标后重试', '场景任务超时，请缩小目标后重新生成。'],
  ['场景正文为空或超出单场景范围，请缩小目标后重试', '场景正文为空或超出范围，请缩小场景目标后重试。'],
  ['AI 输出达到长度上限，结果不完整，请缩小范围后重试', '生成达到长度上限，请降低目标字数后重试；部分内容不可使用。'],
  ['本机模型任务过大，请缩小范围', '本机模型输入过大，请减少场景目标和相关背景资料后重试。'],
  ['本机连接器已离线，请在电脑上重新连接', '本机连接器已离线，请重新连接或手动选择其他模型。'],
  ['本机模型已不可用，请刷新模型列表', '本机模型已不可用，请刷新模型列表并重新选择模型。'],
  ['本机模型连接不存在或无权使用', '当前本机模型连接不可用，请重新选择模型。'],
  ['本机模型连接尚未启用，请在模型连接页确认', '请先在模型连接页启用当前本机模型，或重新选择模型。'],
  ['本机模型任务繁忙，请稍后重试', '本机模型任务繁忙，请稍后重试。'],
  ['本机模型调用失败，请在本机检查模型服务', '本机模型调用失败，请检查本机模型服务或重新选择模型。'],
])
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown, max = 60_000): value is string => typeof value === 'string' && value.length <= max
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function isScenePlan(value: unknown): value is ScenePlan {
  return record(value) && text(value.goal, 600) && Boolean(value.goal.trim()) && text(value.withheld, 600)
    && text(value.pov, 300) && Boolean(value.pov.trim()) && text(value.ending, 400)
    && count(value.targetChars) && value.targetChars >= 200 && value.targetChars <= 1600
}

function isFinding(value: unknown): value is SceneFinding {
  return record(value) && ['id', 'constraintId', 'constraint', 'quote', 'reason', 'suggestion'].every(key => text(value[key]))
    && ['goal', 'revelation', 'pov', 'continuity', 'style'].includes(String(value.kind))
    && ['conflict', 'suggestion'].includes(String(value.severity))
    && count(value.start) && count(value.end) && value.end >= value.start && typeof value.repairable === 'boolean'
}

function isSceneResult(value: unknown): value is SceneResult {
  if (!record(value) || !isScenePlan(value.plan) || !text(value.draft) || !text(value.revised)
    || !value.draft.trim() || !value.revised.trim() || typeof value.repairApplied !== 'boolean'
    || !Array.isArray(value.findings) || value.findings.length > 200 || !value.findings.every(isFinding)
    || !Array.isArray(value.warnings) || value.warnings.length > 100 || !value.warnings.every(item => text(item, 4000))) return false
  const draft = value.draft
  if (!value.findings.every(finding => finding.quote.length > 0 && finding.end <= draft.length
    && draft.slice(finding.start, finding.end) === finding.quote)) return false
  const metrics = value.metrics
  if (!record(metrics) || typeof metrics.durationMs !== 'number' || !Number.isFinite(metrics.durationMs) || metrics.durationMs < 0
    || !count(metrics.requestCount) || !count(metrics.attemptCount) || !record(metrics.usage)) return false
  return text(metrics.usage.status, 32) && count(metrics.usage.knownInputTokens) && count(metrics.usage.knownOutputTokens)
}

function sceneError(data: unknown): string {
  if (record(data) && text(data.message, 500)) {
    const message = data.message.replace(/^AI 服务调用失败: /, '')
    if (/^当前任务资料估算需要 \d{1,12} tokens，超过可用输入预算 \d{1,12}；请缩小待处理范围或减少背景资料后重试。$/.test(message)) {
      return '作品资料超过模型输入预算，请减少场景目标和相关背景资料，或手动选择上下文更大的模型。'
    }
    const safe = SAFE_ERRORS.get(message)
    if (safe) return safe
  }
  return '场景生成失败，请重试；部分内容不可使用。'
}

/** Require result, done and [DONE]. Never expose a partial result as writable. */
async function streamScene<T>(
  path: string,
  payload: SceneRequest | (SceneRequest & { plan: ScenePlan; auto_repair: boolean }),
  signal: AbortSignal,
  onProgress: (event: SceneProgress) => void,
  validate: (value: unknown) => value is T,
  stages: SceneStage[],
): Promise<T> {
  signal.throwIfAborted()
  const token = localStorage.getItem('token')
  const baseURL = (api.defaults.baseURL || '/api').replace(/\/$/, '')
  let response: Response
  try {
    response = await fetch(`${baseURL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload), signal,
    })
  } catch {
    signal.throwIfAborted()
    throw new SceneStreamError('无法连接场景服务，请稍后重试。')
  }
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {})
    signal.throwIfAborted()
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    const message = response.status === 401 ? '登录已失效，请重新登录。'
      : response.status === 403 ? '无法访问当前作品，请检查账号。'
        : response.status === 404 ? '作品或章节不存在或已无法访问，请重新选择章节。'
          : response.status === 400 || response.status === 422 ? '场景输入不符合要求，请检查意图、目标和字数后重试。'
            : response.status === 429 ? '请求较多，请稍后重试。' : '场景请求失败，请稍后重试。'
    throw new SceneStreamError(message)
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    void response.body?.cancel().catch(() => {})
    throw new SceneStreamError(FORMAT_ERROR)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new SceneStreamError(INCOMPLETE_ERROR)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let dataLines: string[] = []
  let frameSize = 0
  let bytes = 0
  let result: T | undefined
  let doneEvent = false
  let sentinel = false
  let currentStage: SceneStage = 'context'
  const dispatch = () => {
    if (!dataLines.length) return
    const raw = dataLines.join('\n')
    dataLines = []
    frameSize = 0
    signal.throwIfAborted()
    if (raw === '[DONE]') {
      if (!doneEvent || result === undefined) throw new SceneStreamError(INCOMPLETE_ERROR)
      sentinel = true
      return
    }
    let event: unknown
    try { event = JSON.parse(raw) } catch { throw new SceneStreamError(FORMAT_ERROR) }
    if (!record(event)) throw new SceneStreamError(FORMAT_ERROR)
    if (event.type === 'error') throw new SceneStreamError(sceneError(event.data))
    if (doneEvent) throw new SceneStreamError(FORMAT_ERROR)
    if (event.type === 'done') {
      if (result === undefined) throw new SceneStreamError(INCOMPLETE_ERROR)
      doneEvent = true
    } else if (event.type === 'result') {
      if (result !== undefined || !validate(event.data)) throw new SceneStreamError(FORMAT_ERROR)
      result = event.data
    } else if (event.type === 'stage') {
      if (result !== undefined || !record(event.data) || !stages.includes(event.data.stage as SceneStage)) throw new SceneStreamError(FORMAT_ERROR)
      currentStage = event.data.stage as SceneStage
      onProgress({ type: 'stage', data: { stage: currentStage } })
    } else if (event.type === 'token') {
      if (result !== undefined || currentStage !== 'draft' || !stages.includes('draft') || !record(event.data) || !text(event.data.text)) throw new SceneStreamError(FORMAT_ERROR)
      onProgress({ type: 'token', data: { text: event.data.text } })
    } else throw new SceneStreamError(FORMAT_ERROR)
  }
  const line = (value: string) => {
    const normalized = value.replace(/\r$/, '')
    if (!normalized) dispatch()
    else if (normalized.startsWith('data:')) {
      frameSize += normalized.length
      if (frameSize > MAX_FRAME) throw new SceneStreamError(FORMAT_ERROR)
      dataLines.push(normalized.slice(5).replace(/^ /, ''))
    }
  }
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (!sentinel) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      bytes += chunk.value?.byteLength || 0
      if (bytes > MAX_STREAM) throw new SceneStreamError(FORMAT_ERROR)
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      let newline: number
      while (!sentinel && (newline = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (buffer.length > MAX_FRAME) throw new SceneStreamError(FORMAT_ERROR)
      if (chunk.done) {
        if (buffer) line(buffer)
        dispatch()
        break
      }
    }
    if (!sentinel || !doneEvent || result === undefined) throw new SceneStreamError(INCOMPLETE_ERROR)
    return result
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof SceneStreamError) throw error
    throw new SceneStreamError(INCOMPLETE_ERROR)
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function streamScenePlan(payload: SceneRequest, signal: AbortSignal, onProgress: (event: SceneProgress) => void = () => {}) {
  return streamScene('/ai/scene/plan/stream', payload, signal, onProgress,
    (value): value is { plan: ScenePlan } => record(value) && isScenePlan(value.plan), ['context', 'plan'])
}

export function streamSceneDraft(payload: SceneRequest & { plan: ScenePlan; auto_repair: boolean }, signal: AbortSignal, onProgress: (event: SceneProgress) => void = () => {}) {
  return streamScene('/ai/scene/stream', payload, signal, onProgress, isSceneResult, ['context', 'draft', 'review', 'repair'])
}
