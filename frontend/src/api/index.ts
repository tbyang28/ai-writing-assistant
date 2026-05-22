import axios from 'axios'

const API_URL = import.meta.env.VITE_API_URL || '/api'

export const api = axios.create({ baseURL: API_URL })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
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
