// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App, type Component } from 'vue'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useAiStore } from '@/stores/ai'
import { useLocalProvidersStore, type LocalConnection } from '@/stores/localProviders'
import ModelsView from '@/views/ModelsView.vue'
import AiPanel from './AiPanel.vue'

let app: App | undefined
let root: HTMLDivElement
let pinia: ReturnType<typeof createPinia>
const modelValue = 'local/device-1/ollama/qwen%2F8b'
const device = (enabled = false, online = true): LocalConnection => ({
  id: 'device-1', name: '写作电脑', enabled, online, lastSeenAt: new Date().toISOString(), detectedClis: ['codex'],
  providers: [{ id: 'ollama', models: [{ id: 'qwen/8b', label: 'Qwen 8B', model: modelValue, tools: false, contextWindow: 32768 }] }],
})
const response = (connection = device()) => ({ data: { connections: [connection], runtimeVersion: 1 } })
async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }
function button(label: string) {
  const element = Array.from(root.querySelectorAll('button')).find(item => item.textContent?.trim() === label)
  if (!element) throw new Error(`Missing button ${label}: ${root.textContent}`)
  return element
}
function mount(component: Component = ModelsView) {
  app = createApp({ render: () => h(component, component === AiPanel ? { bookId: 'book-1', chapterId: 'chapter-1', chapterContent: '当前草稿' } : {}) })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }, { path: '/settings/models', component: ModelsView }] })
  app.use(pinia).use(router).mount(root)
  return useLocalProvidersStore()
}
function inputText(selector: string, value: string) {
  const input = root.querySelector<HTMLTextAreaElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().setAuth('token-a', { id: 'a', name: '作者', email: 'a@test.com', avatar: '' })
  root = document.createElement('div')
  document.body.append(root)
  vi.spyOn(api, 'get').mockResolvedValue(response())
})
afterEach(() => {
  app?.unmount(); app = undefined
  disposePinia(pinia)
  root.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('model connection page', () => {
  it('requires explicit context consent before enabling and inline confirmation before revoke, including error retry', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: device(true) })
    const remove = vi.spyOn(api, 'delete').mockRejectedValueOnce(new Error('暂时断线')).mockResolvedValue({ status: 204 })
    const confirm = vi.spyOn(window, 'confirm')
    mount()
    await settle()
    expect(root.textContent).toContain('云端不能扫描你的电脑')
    expect(root.textContent).toContain('作品记忆与 embedding 仍由平台处理')
    expect(root.textContent).toContain('不读取或导入 CLI OAuth、Keychain')
    expect(root.textContent).toContain('未启用')
    button('启用').click()
    await settle()
    expect(put).not.toHaveBeenCalled()
    expect(root.textContent).toContain('允许将作品上下文发送到“写作电脑”？')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('确认启用设备')
    button('取消').click()
    await settle()
    expect(put).not.toHaveBeenCalled()
    button('启用').click()
    await settle()
    button('允许传输上下文并启用').click()
    await settle()
    expect(put).toHaveBeenCalledWith('/local-providers/connections/device-1', { enabled: true })
    expect(root.textContent).toContain('已启用')
    button('撤销连接').click()
    await settle()
    expect(remove).not.toHaveBeenCalled()
    button('确认撤销连接').click()
    await settle()
    expect(root.textContent).toContain('暂时断线')
    expect(root.textContent).toContain('确认撤销“写作电脑”的连接？')
    button('确认撤销连接').click()
    await settle()
    expect(remove).toHaveBeenCalledTimes(2)
    expect(root.textContent).toContain('还没有设备连接')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('shows an in-memory code, selects text on clipboard failure, keeps secrets out of commands, and clears it on unmount', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ data: { code: 'one-time-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('禁止复制')) } })
    const store = mount()
    const persist = vi.spyOn(localStorage, 'setItem')
    button('生成配对码').click()
    await settle()
    const field = root.querySelector<HTMLInputElement>('#pairing-code')!
    expect(field.value).toBe('one-time-secret')
    button('复制配对码').click()
    await settle()
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(field.value.length)
    expect(root.textContent).toContain('自动复制失败')
    const commands = Array.from(root.querySelectorAll('pre')).map(node => node.textContent).join('\n')
    expect(commands).toContain('ai-writing-assistant/local-connector')
    expect(commands).toContain('npm start -- --server')
    expect(commands).not.toContain('one-time-secret')
    expect(commands).not.toContain('--code')
    expect(persist).not.toHaveBeenCalled()
    app!.unmount(); app = undefined
    expect(store.pairing).toBeNull()
  })

  it('uses the configured HTTPS API root in the connector command and refuses credentials or query strings', async () => {
    const original = api.defaults.baseURL
    try {
      api.defaults.baseURL = 'https://writing.example.com/platform/api/'
      mount()
      await settle()
      expect(root.querySelectorAll('pre')[1].textContent).toBe("npm start -- --server 'https://writing.example.com/platform/api'")
      app!.unmount(); app = undefined
      api.defaults.baseURL = 'https://user:password@writing.example.com/api?key=secret'
      mount()
      await settle()
      expect(root.textContent).toContain('当前 API 地址不符合连接器要求')
      expect(root.textContent).not.toContain('password')
      expect(root.textContent).not.toContain('key=secret')
      expect(root.querySelectorAll('pre')).toHaveLength(1)
    } finally { api.defaults.baseURL = original }
  })

  it('polls at low frequency only while visible, refreshes manually, and removes timers and listeners on unmount', async () => {
    vi.useFakeTimers()
    let visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState)
    mount()
    await settle()
    const get = vi.mocked(api.get)
    expect(get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(get).toHaveBeenCalledTimes(2)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(get).toHaveBeenCalledTimes(2)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(get).toHaveBeenCalledTimes(3)
    button('刷新连接').click()
    await settle()
    expect(get).toHaveBeenCalledTimes(4)
    app!.unmount(); app = undefined
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(get).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('exposes retry for a list error and clears open confirmation and code after logout', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('无法加载连接'))
    vi.spyOn(api, 'post').mockResolvedValue({ data: { code: 'private-code', expiresAt: new Date(Date.now() + 300_000).toISOString() } })
    const store = mount()
    await settle()
    expect(root.textContent).toContain('无法加载连接')
    button('重试加载').click()
    await settle()
    button('生成配对码').click()
    button('启用').click()
    await settle()
    useAuthStore().logout()
    await settle()
    expect(store.connections).toEqual([])
    expect(root.querySelector('#pairing-code')).toBeNull()
    expect(root.textContent).not.toContain('允许将作品上下文发送到')
  })
})

describe('AI model catalog integration', () => {
  it('preserves every cloud option, appends device/provider/capabilities and blocks selection of disabled/offline models', async () => {
    const store = mount(AiPanel)
    await settle()
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="选择 AI 模型"]')!
    expect(Array.from(select.querySelectorAll('optgroup[label="云端模型"] option')).map(node => node.textContent)).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V3.2', 'GLM-4.7', 'MiniMax-M2.5'])
    let option = select.querySelector<HTMLOptionElement>(`option[value="${modelValue}"]`)!
    expect(option.disabled).toBe(true)
    expect(option.textContent).toContain('写作电脑 / Ollama · 不支持工具')
    store.connections = [device(true, false)]
    await settle()
    option = select.querySelector<HTMLOptionElement>(`option[value="${modelValue}"]`)!
    expect(option.disabled).toBe(true)
    store.connections = [device(true)]
    await settle()
    select.value = modelValue
    select.dispatchEvent(new Event('change'))
    await settle()
    const ai = useAiStore()
    expect(ai.selectedModel).toBe(modelValue)
    expect(root.textContent).toContain('服务端会自动禁用工具')
    store.connections = [device(true, false)]
    await settle()
    expect(ai.selectedModel).toBe(modelValue)
    expect(select.value).toBe(modelValue)
    expect(root.textContent).toContain('不会自动切换云端')
    expect(button('续写接在章末').disabled).toBe(true)
    store.connections = []
    await settle()
    expect(select.value).toBe(modelValue)
    expect(root.textContent).toContain('当前本地模型（不可用）')
    expect(ai.selectedModel).toBe(modelValue)
  })

  it('sends the exact server-issued model value in existing writing and Agent bodies, and explains tool downgrade', async () => {
    vi.mocked(api.get).mockResolvedValue(response(device(true)))
    const fetchMock = vi.fn().mockImplementation(async () => new Response('data: {"type":"token","data":{"text":"本机回答"}}\n\ndata: {"type":"done","data":{}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const store = mount(AiPanel)
    await settle()
    const select = root.querySelector<HTMLSelectElement>('select')!
    select.value = modelValue
    select.dispatchEvent(new Event('change'))
    await settle()
    button('续写接在章末').click()
    await vi.waitFor(() => expect(useAiStore().isLoading).toBe(false))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ book_id: 'book-1', chapter_id: 'chapter-1', content: '当前草稿', command: 'continue', model: modelValue })
    button('Agent').click()
    await settle()
    expect(root.textContent).toContain('无法检索作品或生成工具提案')
    inputText('#agent-message', '帮我构思')
    await settle()
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ model: modelValue, message: '帮我构思', current_content: '当前草稿' })
    store.connections = [device(true, false)]
    await settle()
    expect(root.textContent).toContain('不会自动切换云端')
    inputText('#agent-message', '离线时禁止发送')
    await settle()
    expect(button('发送任务').disabled).toBe(true)
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
