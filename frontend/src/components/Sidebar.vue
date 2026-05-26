<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const themeStore = useThemeStore()

const navItems = computed(() => [
  { path: '/', label: '我的作品', icon: '📚', active: route.path === '/' },
])

function handleLogout() {
  authStore.logout()
  router.push('/auth')
}
</script>

<template>
  <aside class="w-16 lg:w-56 flex flex-col shrink-0"
    :style="{ backgroundColor: 'var(--surface)', borderRightColor: 'var(--border-clr)', borderRightWidth: '1px' }">
    <!-- Logo -->
    <div class="h-14 flex items-center justify-center lg:justify-start lg:px-4 border-b"
      :style="{ borderBottomColor: 'var(--border-clr)' }">
      <span class="text-lg font-bold text-brand hidden lg:block">AI 写作助手</span>
      <span class="text-lg font-bold text-brand lg:hidden">✍</span>
    </div>

    <!-- Nav -->
    <nav class="flex-1 py-4 px-2 space-y-1">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="flex items-center justify-center lg:justify-start gap-3 px-2 lg:px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
        :class="item.active ? 'bg-brand-50 text-brand' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'"
      >
        <span class="text-lg">{{ item.icon }}</span>
        <span class="hidden lg:inline">{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- User & Theme Toggle -->
    <div class="border-t p-3 space-y-1"
      :style="{ borderTopColor: 'var(--border-clr)' }">
      <div class="hidden lg:flex items-center gap-2 mb-2 px-1">
        <div class="w-7 h-7 rounded-full bg-brand text-white flex items-center justify-center text-xs font-bold">
          {{ (authStore.user?.name || 'U')[0] }}
        </div>
        <span class="text-sm truncate flex-1" :style="{ color: 'var(--text-primary)' }">{{ authStore.user?.name || '用户' }}</span>
      </div>

      <!-- Dark mode toggle -->
      <button @click="themeStore.toggle()"
        class="w-full flex items-center justify-center lg:justify-start gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
        :class="themeStore.isDark ? 'text-yellow-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'">
        <span class="text-base">{{ themeStore.isDark ? '☀️' : '🌙' }}</span>
        <span class="hidden lg:inline">{{ themeStore.isDark ? '浅色模式' : '深色模式' }}</span>
      </button>

      <button @click="handleLogout"
        class="w-full flex items-center justify-center lg:justify-start gap-2 px-3 py-2 text-sm rounded-lg transition-colors"
        :class="'text-gray-500 hover:text-red-500 hover:bg-red-50 dark:text-gray-400 dark:hover:text-red-400 dark:hover:bg-red-900/20'">
        <span>🚪</span>
        <span class="hidden lg:inline">退出登录</span>
      </button>
    </div>
  </aside>
</template>
