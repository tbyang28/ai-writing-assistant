// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ScenePanel from './ScenePanel.vue'
import AiPanel from './AiPanel.vue'
import { useAuthStore } from '@/stores/auth'
import { useAiStore } from '@/stores/ai'
import { useAgentStore } from '@/stores/agent'
import type { ScenePlan, SceneResult } from '@/api/scene'

const plan: ScenePlan = { goal: '试探旧友', withheld: '来信人身份', pov: '主角限知', ending: '发现信封', targetChars: 600 }
const result: SceneResult = {
  plan, draft: '他知道旧友的所有心思。', revised: '他猜不透旧友的心思。', repairApplied: true, warnings: ['修订结果未再次审阅'],
  findings: [{ id: 'f1', kind: 'pov', severity: 'conflict', constraintId: 'pov', constraint: '主角限知', quote: '知道旧友的所有心思', start: 1, end: 10,
    reason: '可能泄露他人的内心', suggestion: '改为主角的观察', repairable: true }],
  metrics: { durationMs: 2000, requestCount: 3, attemptCount: 3, usage: { status: 'partial', knownInputTokens: 100, knownOutputTokens: 200 } },
}
const frame = (type: string, data: unknown = {}) => `data: ${JSON.stringify({ type, data })}\n\n`
const terminal = (data: unknown) => frame('result', data) + frame('done') + 'data: [DONE]\n\n'
function respond(raw: string) {
  return new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode(raw)); stream.close() } }), { headers: { 'content-type': 'text/event-stream' } })
}
function pendingStream() {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller }, cancel }), { headers: { 'content-type': 'text/event-stream' } })
  return { response, cancel, send: (raw: string) => stream.enqueue(new TextEncoder().encode(raw)) }
}
let app: App | undefined
let root: HTMLDivElement
const tick = async () => { await Promise.resolve(); await nextTick() }
function button(label: string) {
  const element = Array.from(root.querySelectorAll('button')).find(node => node.textContent?.trim() === label)
  if (!element) throw new Error(`Missing button: ${label}\n${root.textContent}`)
  return element
}
function field(label: string) {
  const element = Array.from(root.querySelectorAll('label')).find(node => node.textContent?.trim() === label)
  if (!element?.htmlFor) throw new Error(`Missing field: ${label}`)
  return document.getElementById(element.htmlFor) as HTMLInputElement | HTMLTextAreaElement
}
async function input(label: string, value: string) {
  const element = field(label)
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}
function mount(parent = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const props = reactive({ bookId: 'book-1', chapterId: 'chapter-1', chapterContent: '已有正文', model: null as string | null, blocked: false, modelUnavailable: false })
  const apply = vi.fn()
  const busy = vi.fn()
  app = createApp({ render: () => parent ? h(AiPanel, { bookId: props.bookId, chapterId: props.chapterId, chapterContent: props.chapterContent, onApplyChange: apply })
    : h(ScenePanel, { ...props, onApplyChange: apply, onBusy: busy }) })
  app.use(pinia)
  if (parent) app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }, { path: '/settings/models', component: { render: () => null } }] }))
  app.mount(root)
  return { props, apply, busy, auth: useAuthStore(), ai: useAiStore(), agent: useAgentStore() }
}
async function organize() {
  await input('这场戏想写什么？', '写一场雨夜试探')
  button('整理场景目标').click()
  await vi.waitFor(() => expect(root.textContent).toContain('可编辑的场景目标'))
  await tick()
}
async function generate() {
  button('生成并审阅').click()
  await vi.waitFor(() => expect(root.textContent).toContain('以下为 AI 对初稿的审阅建议'))
}
function responses(next = respond(terminal(result))) {
  const fetchMock = vi.fn().mockResolvedValueOnce(respond(terminal({ plan }))).mockResolvedValueOnce(next)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
})
afterEach(() => { app?.unmount(); app = undefined; root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('scene writing interactions', () => {
  it('edits the plan, reviews evidence, and emits only an explicit append preview with the chapter snapshot', async () => {
    const fetchMock = responses()
    const { apply, busy, props } = mount()
    expect(button('整理场景目标').disabled).toBe(true)
    expect(root.querySelector('h3')?.textContent).toBe('场景目标续写')
    expect(root.textContent).toContain('基于章末与相关作品资料')
    await organize()
    expect(field('暂不揭露的信息（可留空）').value).toBe(plan.withheld)
    expect(field('叙述视角').value).toBe(plan.pov)
    expect(field('场景终点（可留空）').value).toBe(plan.ending)
    await input('作者目标', '让旧友露出破绽')
    await generate()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      book_id: props.bookId, chapter_id: props.chapterId, content: props.chapterContent, intent: '写一场雨夜试探', model: null,
      plan: { ...plan, goal: '让旧友露出破绽' }, auto_repair: false,
    })
    expect(busy.mock.calls.map(([value]) => value)).toEqual([false, true, false, true, false])
    expect(root.textContent).toContain('不是事实证明')
    expect(root.textContent).toContain('修订稿尚未再次审阅')
    expect(root.querySelector('blockquote')?.textContent).toBe(result.findings[0].quote)
    expect(root.textContent).toContain('对应约束：主角限知')
    expect(root.textContent).toContain('可能冲突')
    expect(apply).not.toHaveBeenCalled()
    expect(root.querySelector('[aria-label="场景结果正文"]')?.textContent).toBe(result.revised)
    button('预览追加到章末').click()
    expect(apply).toHaveBeenLastCalledWith({ chapterId: 'chapter-1', original: '已有正文', start: 4, end: 4, replacement: '\n\n' + result.revised, label: '场景目标续写追加预览' })
    button('初稿').click()
    await tick()
    expect(button('初稿').getAttribute('aria-pressed')).toBe('true')
    button('预览追加到章末').click()
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ replacement: '\n\n' + result.draft, label: '场景初稿追加预览' }))
  })

  it('requests at most one optional repair only after opting in', async () => {
    const fetchMock = responses()
    mount()
    await organize()
    const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.checked).toBe(false)
    checkbox.click()
    await tick()
    await generate()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).auto_repair).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['作者目标', '暂不揭露的信息（可留空）', '叙述视角', '场景终点（可留空）', '目标字数（200–1600）'])('permanently invalidates a finished draft when %s is edited and restored', async label => {
    responses()
    const { apply } = mount()
    await organize()
    await generate()
    const original = field(label).value
    await input(label, label.startsWith('目标字数') ? '700' : '新目标')
    await input(label, original)
    expect(root.textContent).toContain('这份结果已过期')
    expect(button('预览追加到章末').disabled).toBe(true)
    button('预览追加到章末').click()
    expect(apply).not.toHaveBeenCalled()
    expect(button('生成并审阅').disabled).toBe(false)
  })

  it.each(['content', 'intent', 'model'] as const)('requires a new plan and blocks stale drafts after %s changes', async change => {
    responses()
    const { props, apply } = mount()
    await organize()
    await generate()
    if (change === 'content') props.chapterContent += '新正文'
    if (change === 'model') props.model = 'local/device/model-without-tools'
    if (change === 'intent') await input('这场戏想写什么？', '新的场景意图')
    await tick()
    expect(root.textContent).toContain('请重新整理场景目标')
    expect(button('预览追加到章末').disabled).toBe(true)
    expect(button('生成并审阅').disabled).toBe(true)
    button('预览追加到章末').click()
    expect(apply).not.toHaveBeenCalled()
  })

  it.each(['chapter', 'book', 'account', 'token'] as const)('cancels active generation and clears private output on %s changes', async change => {
    const stream = pendingStream()
    responses(stream.response)
    const { props, auth, busy, apply } = mount()
    await organize()
    button('生成并审阅').click()
    stream.send(frame('stage', { stage: 'draft' }) + frame('token', { text: '旧账号的半篇正文' }))
    await vi.waitFor(() => expect(root.textContent).toContain('旧账号的半篇正文'))
    if (change === 'chapter') props.chapterId = 'chapter-2'
    if (change === 'book') props.bookId = 'book-2'
    if (change === 'account') auth.user = { id: 'user-2', name: '作者', email: '', avatar: '' }
    if (change === 'token') auth.token = 'new-session'
    await tick()
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(busy).toHaveBeenLastCalledWith(false)
    expect(root.textContent).not.toContain('旧账号的半篇正文')
    expect(field('这场戏想写什么？').value).toBe('')
    expect(root.querySelector('fieldset')).toBeNull()
    expect(apply).not.toHaveBeenCalled()
  })

  it.each(['content', 'intent', 'model', 'plan'] as const)('cancels the active draft on %s edits', async change => {
    const stream = pendingStream()
    responses(stream.response)
    const { props, apply } = mount()
    await organize()
    button('生成并审阅').click()
    stream.send(frame('stage', { stage: 'draft' }) + frame('token', { text: '旧输入的半篇正文' }))
    await vi.waitFor(() => expect(root.textContent).toContain('旧输入的半篇正文'))
    if (change === 'content') props.chapterContent = '修改后的正文'
    if (change === 'model') props.model = 'another-model'
    if (change === 'intent') await input('这场戏想写什么？', '新的任务')
    if (change === 'plan') await input('叙述视角', '第一人称')
    await tick()
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(root.textContent).not.toContain('旧输入的半篇正文')
    expect(root.textContent).toContain('已停止生成')
    expect(root.querySelector('[aria-label="场景结果正文"]')).toBeNull()
    expect(apply).not.toHaveBeenCalled()
  })

  it('clears a completed preview when the account changes', async () => {
    responses()
    const { auth, apply } = mount()
    await organize()
    await generate()
    auth.user = { id: 'new-user', name: '新作者', email: '', avatar: '' }
    await tick()
    expect(root.querySelector('[aria-label="场景结果正文"]')).toBeNull()
    expect(root.textContent).not.toContain(result.revised)
    expect(apply).not.toHaveBeenCalled()
  })

  it('supports stop and unmount cancellation without keeping partial drafts usable', async () => {
    const first = pendingStream()
    const second = pendingStream()
    const fetchMock = responses(first.response).mockResolvedValueOnce(second.response)
    const { busy, apply } = mount()
    await organize()
    button('生成并审阅').click()
    first.send(frame('stage', { stage: 'review' }))
    await vi.waitFor(() => expect(root.textContent).toContain('正在审阅初稿'))
    button('停止生成').click()
    await tick()
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('部分内容不可使用')
    expect(button('生成并审阅').disabled).toBe(false)
    button('生成并审阅').click()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    app!.unmount()
    app = undefined
    expect(second.cancel).toHaveBeenCalledOnce()
    expect(busy).toHaveBeenLastCalledWith(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it.each([
    ['truncated', frame('result', result)],
    ['missing sentinel', frame('result', result) + frame('done')],
    ['error after result', frame('result', result) + frame('error', { message: 'do not display raw model error' })],
    ['malformed', 'data: {broken}\n\n'],
  ])('does not expose a preview for a %s response', async (_name, ending) => {
    responses(respond(frame('stage', { stage: 'draft' }) + frame('token', { text: '半篇正文' }) + ending))
    const { apply, busy } = mount()
    await organize()
    button('生成并审阅').click()
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull())
    expect(root.textContent).not.toContain('半篇正文')
    expect(root.textContent).not.toContain('do not display')
    expect(root.querySelector('[aria-label="场景结果正文"]')).toBeNull()
    expect(busy).toHaveBeenLastCalledWith(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('ignores an old response after switching chapters and starting a new plan', async () => {
    let resolveOld!: (response: Response) => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(respond(terminal({ plan: { ...plan, goal: '新章节目标' } })))
    vi.stubGlobal('fetch', fetchMock)
    const { props } = mount()
    await input('这场戏想写什么？', '旧章节目标')
    button('整理场景目标').click()
    props.chapterId = 'chapter-2'
    await tick()
    await organize()
    resolveOld(respond(terminal({ plan })))
    await tick()
    expect(field('作者目标').value).toBe('新章节目标')
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(button('生成并审阅').disabled).toBe(false)
  })

  it('validates lengths and waits for model availability or the shared busy state', async () => {
    const fetchMock = responses()
    const { props } = mount()
    await input('这场戏想写什么？', '有意图')
    props.blocked = true
    await tick()
    expect(button('整理场景目标').disabled).toBe(true)
    props.blocked = false
    props.modelUnavailable = true
    await tick()
    expect(button('整理场景目标').disabled).toBe(true)
    props.modelUnavailable = false
    props.chapterContent = '字'.repeat(60_001)
    await tick()
    expect(root.textContent).toContain('超过 60000')
    expect(button('整理场景目标').disabled).toBe(true)
    props.chapterContent = ''
    await organize()
    await input('目标字数（200–1600）', '199')
    expect(button('生成并审阅').disabled).toBe(true)
    await input('目标字数（200–1600）', '600.5')
    expect(button('生成并审阅').disabled).toBe(true)
    await input('目标字数（200–1600）', '600')
    await input('作者目标', '  ')
    expect(button('生成并审阅').disabled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('AiPanel scene integration', () => {
  it('keeps the scene heading visible on context reset and scrolls only the active output', async () => {
    const { props, ai } = mount(true)
    const messages = root.querySelector<HTMLElement>('.ai-panel-shell > .overflow-y-auto')!
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 1200 })
    await tick()
    ai.isLoading = true
    await tick()
    await tick()
    expect(messages.scrollTop).toBe(0)
    messages.scrollTop = 180
    props.chapterId = 'chapter-2'
    await tick()
    await tick()
    expect(messages.scrollTop).toBe(0)
    button('问答').click()
    await tick()
    ai.addMessage('assistant', '新的问答输出')
    await vi.waitFor(() => expect(messages.scrollTop).toBe(1200))
  })

  it('shares busy state with ordinary writing and forwards explicit preview proposals', async () => {
    const stream = pendingStream()
    responses(stream.response)
    const { apply } = mount(true)
    await organize()
    button('生成并审阅').click()
    await tick()
    const ordinaryWrite = Array.from(root.querySelectorAll('button')).find(node => node.textContent?.includes('接在章末'))!
    expect(ordinaryWrite.disabled).toBe(true)
    stream.send(terminal(result))
    await vi.waitFor(() => expect(button('预览追加到章末').disabled).toBe(false))
    expect(ordinaryWrite.disabled).toBe(false)
    expect(apply).not.toHaveBeenCalled()
    button('预览追加到章末').click()
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ chapterId: 'chapter-1', original: '已有正文', start: 4, end: 4 }))
  })

  it('blocks scene work while ordinary writing or Agent is busy and cancels before switching tabs', async () => {
    const stream = pendingStream()
    const fetchMock = responses(stream.response)
    const { ai, agent } = mount(true)
    await organize()
    ai.isLoading = true
    await tick()
    expect(button('生成并审阅').disabled).toBe(true)
    ai.isLoading = false
    agent.isLoading = true
    await tick()
    expect(button('生成并审阅').disabled).toBe(true)
    agent.isLoading = false
    await tick()
    button('生成并审阅').click()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    button('问答').click()
    await tick()
    expect(stream.cancel).toHaveBeenCalledOnce()
    const chat = root.querySelector('textarea')!
    chat.value = '讨论场景'
    chat.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(button('发送').disabled).toBe(false)
  })
})
