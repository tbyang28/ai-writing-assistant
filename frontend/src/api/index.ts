import axios from 'axios'

const DEPLOYED_API_URL = 'https://ai-writing-assistant-api-o4nb.onrender.com/api'

function resolveApiUrl() {
  const configured = import.meta.env.VITE_API_URL
  if (window.location.hostname === 'ai-writing-assistant-web.onrender.com') {
    return configured?.includes('ai-writing-assistant-api-o4nb.onrender.com')
      ? configured
      : DEPLOYED_API_URL
  }
  return configured || '/api'
}

const API_URL = resolveApiUrl()

export const api = axios.create({ baseURL: API_URL })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => {
    if (typeof response.data === 'string' && response.data.includes('<!doctype html')) {
      throw new Error(`API 地址配置错误，当前请求打到了前端页面：${response.config.baseURL}`)
    }
    return response
  },
  async (error) => {
    if (error.response?.status === 401 && window.location.pathname !== '/auth') {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      window.location.href = '/auth'
    }
    return Promise.reject(error)
  },
)

export async function apiGet<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data as T
}

export async function apiPost<T>(url: string, data?: unknown): Promise<T> {
  const res = await api.post(url, data)
  return res.data as T
}

export async function apiPut<T>(url: string, data?: unknown): Promise<T> {
  const res = await api.put(url, data)
  return res.data as T
}

export async function apiDelete<T = { success: boolean }>(url: string): Promise<T> {
  const res = await api.delete(url)
  return res.data as T
}
