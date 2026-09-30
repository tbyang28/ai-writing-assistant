import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './assets/main.css'

import AuthView from './views/AuthView.vue'
import LandingView from './views/LandingView.vue'

// 路由级懒加载：登录后各页面（尤其最重的编辑器）按需分包，落地/登录页不再背全量 chunk
const HomeView = () => import('./views/HomeView.vue')
const BooksView = () => import('./views/BooksView.vue')
const InspirationsView = () => import('./views/InspirationsView.vue')
const StatsView = () => import('./views/StatsView.vue')
const EditorView = () => import('./views/EditorView.vue')

function isTokenValid() {
  const token = localStorage.getItem('token')
  if (!token) return false
  try {
    // 只读 exp 做客户端预判（签名仍由服务端校验）
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now()
  } catch {
    return !!token // 解析失败时放行，交给 API 401 拦截
  }
}

function requireAuth(_to: any, _from: any, next: any) {
  if (!isTokenValid()) {
    localStorage.removeItem('token')
    next('/auth')
  } else {
    next()
  }
}

function redirectIfAuthed(_to: any, _from: any, next: any) {
  next(isTokenValid() ? '/home' : undefined)
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'landing', component: LandingView },
    { path: '/auth', name: 'auth', component: AuthView, beforeEnter: redirectIfAuthed },
    { path: '/home', name: 'home', component: HomeView, beforeEnter: requireAuth },
    { path: '/books', name: 'books', component: BooksView, beforeEnter: requireAuth },
    { path: '/inspirations', name: 'inspirations', component: InspirationsView, beforeEnter: requireAuth },
    { path: '/stats', name: 'stats', component: StatsView, beforeEnter: requireAuth },
    { path: '/editor/:id', name: 'editor', component: EditorView, beforeEnter: requireAuth },
  ],
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
