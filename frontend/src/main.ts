import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './assets/main.css'

import AuthView from './views/AuthView.vue'
import HomeView from './views/HomeView.vue'
import EditorView from './views/EditorView.vue'

function requireAuth(to: any, _from: any, next: any) {
  const token = localStorage.getItem('token')
  if (!token && to.path !== '/auth') {
    next('/auth')
  } else {
    next()
  }
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/auth', name: 'auth', component: AuthView },
    { path: '/', name: 'home', component: HomeView, beforeEnter: requireAuth },
    { path: '/editor/:id', name: 'editor', component: EditorView, beforeEnter: requireAuth },
  ],
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
