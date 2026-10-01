import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
export function useCommunityAccess() {
  const auth = useAuthStore(), router = useRouter(), route = useRoute()
  function requireLogin() { if (auth.isLoggedIn) return true; router.push({ path: '/auth', query: { redirect: route.fullPath } }); return false }
  return { auth, requireLogin }
}
