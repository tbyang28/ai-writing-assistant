import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api, apiGet, apiPost } from '@/api'

export interface AuthUser {
  id: string
  email: string
  name: string
  avatar: string
}

function readStoredUser(): AuthUser | null {
  const raw = localStorage.getItem('user')
  if (!raw || raw === 'undefined') {
    localStorage.removeItem('user')
    return null
  }

  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    localStorage.removeItem('user')
    return null
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'))
  const user = ref<AuthUser | null>(readStoredUser())

  const isLoggedIn = computed(() => Boolean(token.value))

  function setAuth(newToken: string, newUser: AuthUser) {
    token.value = newToken
    user.value = newUser
    localStorage.setItem('token', newToken)
    localStorage.setItem('user', JSON.stringify(newUser))
  }

  function logout() {
    token.value = null
    user.value = null
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    delete api.defaults.headers.common.Authorization
  }

  async function login(email: string, password: string) {
    const data: any = await apiPost('/auth/login', { email, password })
    const payload = data.data || data
    setAuth(payload.access_token, payload.user)
    return payload.user
  }

  async function register(email: string, password: string, name?: string) {
    const data: any = await apiPost('/auth/register', { email, password, name })
    const payload = data.data || data
    setAuth(payload.access_token, payload.user)
    return payload.user
  }

  async function fetchProfile() {
    const data: any = await apiGet('/auth/profile')
    const profile = data.data || data
    user.value = profile
    localStorage.setItem('user', JSON.stringify(profile))
    return profile
  }

  return { token, user, isLoggedIn, setAuth, logout, login, register, fetchProfile }
})
