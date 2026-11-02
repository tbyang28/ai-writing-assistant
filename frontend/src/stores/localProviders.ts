import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPost, apiPut } from '@/api'
import { useAuthStore } from './auth'

export interface LocalModel {
  id: string
  label: string
  tools: boolean
  contextWindow?: number
  model: string
}
export interface LocalConnection {
  id: string
  name: string
  enabled: boolean
  online: boolean
  lastSeenAt: string | null
  providers: { id: 'ollama' | 'lmstudio'; models: LocalModel[] }[]
  detectedClis: string[]
}
export interface LocalCatalog { connections: LocalConnection[]; runtimeVersion: 1 }
export interface PairingCode { code: string; expiresAt: string }
export const providerLabel = (id: string) => id === 'lmstudio' ? 'LM Studio' : id === 'ollama' ? 'Ollama' : id
const errorMessage = (error: any, fallback: string): string => error?.response?.data?.detail || error?.message || fallback

export const useLocalProvidersStore = defineStore('localProviders', () => {
  const auth = useAuthStore()
  const connections = ref<LocalConnection[]>([])
  const loaded = ref(false)
  const refreshing = ref(false)
  const error = ref<string | null>(null)
  const actionErrors = ref<Record<string, string>>({})
  const pending = ref<Record<string, boolean>>({})
  const pairing = ref<PairingCode | null>(null)
  const pairingBusy = ref(false)
  const pairingError = ref<string | null>(null)
  let epoch = 0
  let listRequest = 0
  let pairRequest = 0
  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  // Never persist device inventories or pairing codes. Invalidate late responses on account changes.
  function clearPairing() {
    pairRequest += 1
    clearTimeout(expiryTimer)
    expiryTimer = undefined
    pairing.value = null
    pairingBusy.value = false
    pairingError.value = null
  }
  function reset() {
    epoch += 1
    listRequest += 1
    connections.value = []
    loaded.value = false
    refreshing.value = false
    error.value = null
    actionErrors.value = {}
    pending.value = {}
    clearPairing()
  }
  watch(() => [auth.token, auth.user?.id], reset, { flush: 'sync' })
  onScopeDispose(reset)

  async function refresh() {
    if (!auth.token || refreshing.value || Object.values(pending.value).some(Boolean)) return
    const currentEpoch = epoch
    const request = ++listRequest
    refreshing.value = true
    error.value = null
    try {
      const data = await apiGet<LocalCatalog>('/local-providers')
      if (currentEpoch !== epoch || request !== listRequest) return
      connections.value = data.connections
      loaded.value = true
    } catch (err) {
      if (currentEpoch === epoch && request === listRequest) error.value = errorMessage(err, '连接列表加载失败，请重试')
    } finally {
      if (currentEpoch === epoch && request === listRequest) refreshing.value = false
    }
  }

  async function createPairing() {
    if (!auth.token || pairingBusy.value) return
    clearPairing()
    const request = pairRequest
    const currentEpoch = epoch
    pairingBusy.value = true
    try {
      const data = await apiPost<PairingCode>('/local-providers/pairing', {})
      if (currentEpoch !== epoch || request !== pairRequest) return
      const remaining = Math.min(Date.parse(data.expiresAt) - Date.now(), 5 * 60_000)
      if (!(remaining > 0)) throw new Error('配对码已过期，请重新生成')
      pairing.value = data
      expiryTimer = setTimeout(clearPairing, remaining)
    } catch (err) {
      if (currentEpoch === epoch && request === pairRequest) pairingError.value = errorMessage(err, '配对码生成失败，请重试')
    } finally {
      if (currentEpoch === epoch && request === pairRequest) pairingBusy.value = false
    }
  }

  async function changeConnection(id: string, enabled?: boolean) {
    if (!auth.token || pending.value[id]) return false
    const currentEpoch = epoch
    // An older GET must not undo an enable/disable/revoke response.
    listRequest += 1
    refreshing.value = false
    pending.value[id] = true
    delete actionErrors.value[id]
    try {
      const path = `/local-providers/connections/${encodeURIComponent(id)}`
      if (enabled === undefined) {
        await apiDelete(path)
        if (currentEpoch !== epoch) return false
        connections.value = connections.value.filter(item => item.id !== id)
      } else {
        const connection = await apiPut<LocalConnection>(path, { enabled })
        if (currentEpoch !== epoch) return false
        connections.value = connections.value.map(item => item.id === id ? connection : item)
      }
      return true
    } catch (err) {
      if (currentEpoch === epoch) actionErrors.value[id] = errorMessage(err, '操作失败，请重试')
      return false
    } finally {
      if (currentEpoch === epoch) {
        // Also invalidate GETs started while this mutation was in flight.
        listRequest += 1
        refreshing.value = false
        delete pending.value[id]
      }
    }
  }

  const modelOptions = computed(() => connections.value.flatMap(connection => connection.providers.flatMap(provider => provider.models.map(model => ({
    value: model.model,
    label: `${model.label} · ${connection.name} / ${providerLabel(provider.id)} · ${model.tools ? '支持工具' : '不支持工具'}${model.contextWindow ? ` · 上下文 ${model.contextWindow.toLocaleString()}` : ''}`,
    disabled: !connection.enabled || !connection.online,
    reason: !connection.enabled ? '未启用' : !connection.online ? '离线' : '',
    tools: model.tools,
  })))))
  function modelStatus(model?: string | null) {
    if (!model?.startsWith('local/')) return null
    const option = modelOptions.value.find(item => item.value === model)
    if (!option) return { unavailable: true, tools: undefined, message: '当前本地模型不可用或已撤销。请刷新连接、恢复设备，或手动选择其他模型；不会自动切换云端。' }
    return {
      unavailable: option.disabled,
      tools: option.tools,
      message: option.disabled ? `当前本地模型${option.reason}。请恢复连接或手动选择其他模型；不会自动切换云端。` : '',
    }
  }

  return { connections, loaded, refreshing, error, pending, actionErrors, pairing, pairingBusy, pairingError, modelOptions,
    refresh, createPairing, clearPairing, changeConnection, modelStatus }
})
