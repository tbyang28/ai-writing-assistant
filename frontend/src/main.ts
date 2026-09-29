import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './assets/main.css'

import AuthView from './views/AuthView.vue'
import LandingView from './views/LandingView.vue'
import HomeView from './views/HomeView.vue'
import BooksView from './views/BooksView.vue'
import EditorView from './views/EditorView.vue'

function requireAuth(to: any, _from: any, next: any) {
  const token = localStorage.getItem('token')
  if (!token) {
    next('/auth')
  } else {
    next()
  }
}

function redirectIfAuthed(_to: any, _from: any, next: any) {
  const token = localStorage.getItem('token')
  next(token ? '/home' : undefined)
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'landing', component: LandingView },
    { path: '/auth', name: 'auth', component: AuthView, beforeEnter: redirectIfAuthed },
    { path: '/home', name: 'home', component: HomeView, beforeEnter: requireAuth },
    { path: '/books', name: 'books', component: BooksView, beforeEnter: requireAuth },
    { path: '/editor/:id', name: 'editor', component: EditorView, beforeEnter: requireAuth },
  ],
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
