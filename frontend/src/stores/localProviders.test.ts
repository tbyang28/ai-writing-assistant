// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { api } from '@/api'
import { useAuthStore } from './auth'
import { useAiStore } from './ai'
import { useLocalProvidersStore, type LocalConnection } from './localProviders'

let pinia: ReturnType<typeof createPinia>
const connection = (enabled = false, online = true): LocalConnection => ({
  id: 'device-1', name: '我的电脑', enabled, online, lastSeenAt: new Date().toISOString(), detectedClis: ['codex'],
  providers: [{ id: 'ollama', models: [{ id: 'qwen/8b', label: 'Qwen 8B', tools: false, contextWindow: 32768, model: 'local/device-1/ollama/qwen%2F8b' }] }],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const login = (id = 'a') => useAuthStore().setAuth(`token-${id}`, { id, name: id, email: `${id}@test.com`, avatar: '' })
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  pinia = createPinia()
  setActivePinia(pinia)
  login()
})
afterEach(() => { disposePinia(pinia); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('local provider catalog', () => {
  it('uses the JWT API client and direct-object catalog, retaining server-issued model values and online status', async () => {
    const original = api.defaults.adapter
    const adapter = vi.fn(async (config: any) => ({ data: { connections: [connection()], runtimeVersion: 1 }, status: 200, statusText: 'OK', headers: {}, config }))
    api.defaults.adapter = adapter
    try {
      const store = useLocalProvidersStore()
      await store.refresh()
      expect(adapter.mock.calls[0][0].url).toBe('/local-providers')
      expect(adapter.mock.calls[0][0].headers.Authorization).toBe('Bearer token-a')
      expect(store.modelOptions[0]).toMatchObject({ value: 'local/device-1/ollama/qwen%2F8b', disabled: true, reason: '未启用' })
      expect(store.modelOptions[0].label).toContain('我的电脑 / Ollama · 不支持工具 · 上下文 32,768')
      expect(store.connections[0].online).toBe(true)
    } finally { api.defaults.adapter = original }
  })

  it('keeps codes only in memory, expires them at five minutes, and ignores a response after leaving the pairing page', async () => {
    vi.useFakeTimers()
    const store = useLocalProvidersStore()
    const persist = vi.spyOn(localStorage, 'setItem')
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { code: 'secret-code', expiresAt: new Date(Date.now() + 300_000).toISOString() } })
    await store.createPairing()
    expect(post).toHaveBeenCalledWith('/local-providers/pairing', {})
    expect(store.pairing?.code).toBe('secret-code')
    expect(persist).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(store.pairing).toBeNull()
    const late = deferred<any>()
    post.mockReturnValueOnce(late.promise)
    const pending = store.createPairing()
    store.clearPairing()
    late.resolve({ data: { code: 'late-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } })
    await pending
    expect(store.pairing).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates old codes on regeneration and allows retries after pairing failures', async () => {
    const store = useLocalProvidersStore()
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { code: 'old', expiresAt: new Date(Date.now() + 300_000).toISOString() } }).mockRejectedValueOnce(new Error('配对服务暂不可用'))
    await store.createPairing()
    await store.createPairing()
    expect(store.pairing).toBeNull()
    expect(store.pairingError).toBe('配对服务暂不可用')
    post.mockResolvedValueOnce({ data: { code: 'new', expiresAt: new Date(Date.now() + 300_000).toISOString() } })
    await store.createPairing()
    expect(store.pairing?.code).toBe('new')
    expect(store.pairingError).toBeNull()
  })

  it('clears devices, code, errors and selected model across accounts and rejects stale GET/POST/PUT responses', async () => {
    const store = useLocalProvidersStore()
    const ai = useAiStore()
    const get = deferred<any>()
    const post = deferred<any>()
    const put = deferred<any>()
    vi.spyOn(api, 'get').mockReturnValue(get.promise)
    vi.spyOn(api, 'post').mockReturnValue(post.promise)
    vi.spyOn(api, 'put').mockReturnValue(put.promise)
    store.connections = [connection()]
    ai.selectedModel = connection().providers[0].models[0].model
    const requests = [store.refresh(), store.createPairing(), store.changeConnection('device-1', true)]
    login('b')
    expect(store.connections).toEqual([])
    expect(store.pairing).toBeNull()
    expect(ai.selectedModel).toBeNull()
    get.resolve({ data: { connections: [connection(true)], runtimeVersion: 1 } })
    post.resolve({ data: { code: 'account-a-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } })
    put.resolve({ data: connection(true) })
    await Promise.all(requests)
    expect(store.connections).toEqual([])
    expect(store.pairing).toBeNull()
    expect(store.pending).toEqual({})
    expect(store.error).toBeNull()
    expect(store.pairingError).toBeNull()
  })

  it('does not let a stale list undo enable or revoke, and never changes an existing offline selection', async () => {
    const store = useLocalProvidersStore()
    const ai = useAiStore()
    store.connections = [connection()]
    ai.selectedModel = connection().providers[0].models[0].model
    const stale = deferred<any>()
    vi.spyOn(api, 'get').mockReturnValueOnce(stale.promise)
    vi.spyOn(api, 'put').mockResolvedValue({ data: connection(true, false) })
    const oldGet = store.refresh()
    await store.changeConnection('device-1', true)
    stale.resolve({ data: { connections: [connection()], runtimeVersion: 1 } })
    await oldGet
    expect(store.connections[0]).toMatchObject({ enabled: true, online: false })
    expect(store.modelStatus(ai.selectedModel)?.unavailable).toBe(true)
    expect(ai.selectedModel).toBe('local/device-1/ollama/qwen%2F8b')
    const staleRevoke = deferred<any>()
    vi.mocked(api.get).mockReturnValueOnce(staleRevoke.promise)
    const oldRevokeGet = store.refresh()
    const remove = vi.spyOn(api, 'delete').mockResolvedValue({ status: 204 })
    await store.changeConnection('device-1')
    staleRevoke.resolve({ data: { connections: [connection(true)], runtimeVersion: 1 } })
    await oldRevokeGet
    expect(remove).toHaveBeenCalledWith('/local-providers/connections/device-1')
    expect(store.connections).toEqual([])
    expect(store.modelStatus(ai.selectedModel)?.unavailable).toBe(true)
    expect(ai.selectedModel).toBe('local/device-1/ollama/qwen%2F8b')
  })

  it('retains the catalog after a refresh error and retries failed operations without duplicate writes', async () => {
    const store = useLocalProvidersStore()
    store.connections = [connection()]
    const get = vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('列表断线')).mockResolvedValue({ data: { connections: [connection()], runtimeVersion: 1 } })
    await store.refresh()
    expect(store.error).toBe('列表断线')
    expect(store.connections).toHaveLength(1)
    await store.refresh()
    expect(get).toHaveBeenCalledTimes(2)
    expect(store.error).toBeNull()
    const put = deferred<any>()
    const update = vi.spyOn(api, 'put').mockRejectedValueOnce(new Error('启用失败')).mockReturnValueOnce(put.promise)
    await store.changeConnection('device-1', true)
    expect(store.actionErrors['device-1']).toBe('启用失败')
    const success = store.changeConnection('device-1', true)
    await store.changeConnection('device-1', true)
    expect(update).toHaveBeenCalledTimes(2)
    put.resolve({ data: connection(true) })
    await success
    expect(store.connections[0].enabled).toBe(true)
    expect(store.actionErrors['device-1']).toBeUndefined()
  })
})
