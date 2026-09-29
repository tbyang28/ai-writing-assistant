<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { useBookStore } from '@/stores/book'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const bookStore = useBookStore()

const navItems = computed(() => [
  {
    path: '/home',
    label: '工作台',
    active: route.path === '/home',
  },
  {
    path: '/books',
    label: '我的作品',
    active: route.path === '/books' || route.path.startsWith('/editor'),
  },
])

const recentBooks = computed(() => bookStore.books.slice(0, 4))

onMounted(() => {
  if (!bookStore.books.length) {
    bookStore.fetchBooks().catch(() => {})
  }
})

function formatWordCount(count?: number | null) {
  if (!count) return '0'
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}

async function handleLogout() {
  authStore.logout()
  await router.replace('/auth')
}
</script>

<template>
  <aside class="w-16 lg:w-56 flex flex-col shrink-0 border-r"
    :style="{ backgroundColor: 'var(--surface)', borderRightColor: 'var(--border-clr)' }">
    <!-- Logo -->
    <div class="h-16 flex items-center justify-center lg:justify-start lg:px-5 border-b"
      :style="{ borderBottomColor: 'var(--border-clr)' }">
      <div class="flex items-center gap-2.5">
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand text-white">
          <svg class="h-4.5 w-4.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </div>
        <span class="hidden lg:block font-serif text-base font-semibold tracking-wide"
          :style="{ color: 'var(--text-primary)' }">AI 写作助手</span>
      </div>
    </div>

    <!-- Nav -->
    <nav class="py-4 px-2.5 space-y-1">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="flex items-center justify-center lg:justify-start gap-3 px-2 lg:px-3 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150"
        :class="!item.active && 'hover:bg-[var(--surface-hover)]'"
        :style="item.active
          ? { backgroundColor: 'var(--brand-soft)', color: 'var(--brand-hover)' }
          : { color: 'var(--text-secondary)' }"
      >
        <svg v-if="item.path === '/home'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
        <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        </svg>
        <span class="hidden lg:inline">{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- 最近作品快捷列表 -->
    <div class="hidden lg:block flex-1 min-h-0 overflow-y-auto px-2.5 pb-3">
      <div class="px-3 pb-2 text-[11px] font-semibold uppercase" :style="{ letterSpacing: '0.14em', color: 'var(--text-muted)' }">
        最近作品
      </div>
      <div class="space-y-0.5">
        <button
          v-for="book in recentBooks"
          :key="book.id"
          @click="router.push(`/editor/${book.id}`)"
          class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-colors duration-150 hover:bg-[var(--surface-hover)]"
        >
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-brand opacity-70"></span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px] font-medium" :style="{ color: 'var(--text-primary)' }">{{ book.title }}</span>
            <span class="block text-[11px]" :style="{ color: 'var(--text-muted)' }">{{ formatWordCount(book.word_count) }} 字</span>
          </span>
        </button>
        <div v-if="!recentBooks.length" class="px-3 py-2 text-xs" :style="{ color: 'var(--text-muted)' }">
          还没有作品
        </div>
      </div>
    </div>

    <!-- User & Theme Toggle -->
    <div class="border-t p-3 space-y-1"
      :style="{ borderTopColor: 'var(--border-clr)' }">
      <div class="hidden lg:flex items-center gap-2.5 mb-2 px-1.5">
        <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
          :style="{ backgroundColor: 'var(--ink)', color: 'var(--ink-text)' }">
          {{ (authStore.user?.name || 'U')[0].toUpperCase() }}
        </div>
        <span class="text-sm truncate flex-1" :style="{ color: 'var(--text-primary)' }">{{ authStore.user?.name || '用户' }}</span>
      </div>

      <!-- Dark mode toggle -->
      <button type="button" @click="themeStore.toggle()"
        class="w-full flex items-center justify-center lg:justify-start gap-2.5 px-3 py-2 rounded-xl text-sm transition-colors duration-150 hover:bg-[var(--surface-hover)]"
        :style="{ color: 'var(--text-secondary)' }">
        <svg v-if="themeStore.isDark" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        <svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
        <span class="hidden lg:inline">{{ themeStore.isDark ? '浅色模式' : '深色模式' }}</span>
      </button>

      <button type="button" @click="handleLogout"
        class="w-full flex items-center justify-center lg:justify-start gap-2.5 px-3 py-2 text-sm rounded-xl transition-colors duration-150 hover:bg-[var(--surface-hover)]"
        :style="{ color: 'var(--text-muted)' }">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" x2="9" y1="12" y2="12" />
        </svg>
        <span class="hidden lg:inline">退出登录</span>
      </button>
    </div>
  </aside>
</template>
