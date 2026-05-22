<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const navItems = computed(() => [
  { path: '/', label: '我的作品', icon: '📚', active: route.path === '/' },
])

function handleLogout() {
  authStore.logout()
  router.push('/auth')
}
</script>

<template>
  <aside class="w-16 lg:w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
    <!-- Logo -->
    <div class="h-14 flex items-center justify-center lg:justify-start lg:px-4 border-b border-gray-100">
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
        :class="item.active ? 'bg-brand-50 text-brand' : 'text-gray-600 hover:bg-gray-100'"
      >
        <span class="text-lg">{{ item.icon }}</span>
        <span class="hidden lg:inline">{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- User -->
    <div class="border-t border-gray-100 p-3">
      <div class="hidden lg:flex items-center gap-2 mb-2 px-1">
        <div class="w-7 h-7 rounded-full bg-brand text-white flex items-center justify-center text-xs font-bold">
          {{ (authStore.user?.name || 'U')[0] }}
        </div>
        <span class="text-sm text-gray-700 truncate flex-1">{{ authStore.user?.name || '用户' }}</span>
      </div>
      <button @click="handleLogout" class="w-full flex items-center justify-center lg:justify-start gap-2 px-3 py-2 text-sm text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
        <span>🚪</span>
        <span class="hidden lg:inline">退出登录</span>
      </button>
    </div>
  </aside>
</template>
