import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useLocalProvidersStore } from '@/stores/localProviders'

// Only mounted, visible consumers poll. Server heartbeats determine online status (30s).
export function useLocalProviderCatalog() {
  const store = useLocalProvidersStore()
  const auth = useAuthStore()
  let timer: ReturnType<typeof setInterval> | undefined
  let mounted = false
  function sync() {
    clearInterval(timer)
    timer = undefined
    if (!mounted || !auth.token || document.visibilityState === 'hidden') return
    void store.refresh()
    timer = setInterval(() => { void store.refresh() }, 30_000)
  }
  watch(() => [auth.token, auth.user?.id], sync)
  onMounted(() => {
    mounted = true
    document.addEventListener('visibilitychange', sync)
    sync()
  })
  onBeforeUnmount(() => {
    mounted = false
    clearInterval(timer)
    document.removeEventListener('visibilitychange', sync)
  })
  return store
}
