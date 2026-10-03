<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { useBookStore } from '@/stores/book'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const bookStore = useBookStore()

// 工作台展示完整导航；进入功能页后给内容留出更多空间。
const collapsed = ref(route.path !== '/home')
watch(() => route.path, (path) => {
  collapsed.value = path !== '/home'
})

const navGroups = computed(() => [
  {
    label: '工作台',
    items: [
      { path: '/home', label: '工作台', icon: 'home', active: route.path === '/home' },
    ],
  },
  {
    label: '创作管理',
    items: [
      { path: '/books', label: '我的作品', icon: 'book', active: route.path === '/books' || route.path.startsWith('/editor/') },
      { path: '/inspirations', label: '灵感库', icon: 'sparkle', active: route.path === '/inspirations' },
    ],
  },
  {
    label: '数据回顾',
    items: [
      { path: '/stats', label: '写作统计', icon: 'chart', active: route.path === '/stats' },
    ],
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
  <aside class="app-sidebar w-16 flex flex-col shrink-0 border-r"
    :class="{ 'sidebar-expanded': !collapsed }"
    aria-label="主导航"
    :style="{ backgroundColor: 'var(--surface)', borderRightColor: 'var(--border-clr)' }">
    <!-- 品牌与收起 / 展开开关 -->
    <div class="sidebar-header h-16 flex items-center justify-center shrink-0 border-b"
      :style="{ borderBottomColor: 'var(--border-clr)' }">
      <div v-if="!collapsed" class="hidden lg:flex min-w-0 items-center gap-2">
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand text-white">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </div>
        <span class="font-serif text-sm font-semibold whitespace-nowrap"
          :style="{ color: 'var(--text-primary)' }">AI 写作助手</span>
      </div>
      <button type="button" @click="collapsed = !collapsed"
        class="hidden lg:flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--surface-hover)] transition-colors"
        :style="{ color: 'var(--text-secondary)' }"
        :aria-label="collapsed ? '展开导航' : '收起导航'"
        :title="collapsed ? '展开导航' : '收起导航'"
        :aria-expanded="!collapsed" aria-controls="sidebar-navigation">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
          <path :d="collapsed ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3'" />
        </svg>
      </button>
      <div class="lg:hidden flex h-8 w-8 items-center justify-center rounded-xl bg-brand text-white" aria-label="AI 写作助手">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </div>
    </div>

    <!-- Nav -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <nav id="sidebar-navigation" aria-label="功能导航" class="py-4 px-2.5 space-y-4">
        <section v-for="group in navGroups" :key="group.label" :aria-label="group.label" class="sidebar-nav-group">
          <h2 v-if="!collapsed" class="hidden lg:block px-3 mb-2 text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">{{ group.label }}</h2>
          <div class="space-y-1">
            <router-link
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              :title="item.label"
              :aria-label="item.label"
              :aria-current="item.active ? 'page' : undefined"
              class="sidebar-action flex min-h-11 items-center justify-center gap-3 px-2 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150"
              :class="!item.active && 'hover:bg-[var(--surface-hover)]'"
              :style="item.active
                ? { backgroundColor: 'var(--brand-soft)', color: 'var(--brand-hover)' }
                : { color: 'var(--text-secondary)' }"
            >
              <svg v-if="item.icon === 'home'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <svg v-else-if="item.icon === 'book'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
              </svg>
              <svg v-else-if="item.icon === 'sparkle'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3l1.9 5.7a2 2 0 0 0 1.4 1.4L21 12l-5.7 1.9a2 2 0 0 0-1.4 1.4L12 21l-1.9-5.7a2 2 0 0 0-1.4-1.4L3 12l5.7-1.9a2 2 0 0 0 1.4-1.4L12 3z" />
              </svg>
              <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" x2="18" y1="20" y2="10" />
                <line x1="12" x2="12" y1="20" y2="4" />
                <line x1="6" x2="6" y1="20" y2="14" />
              </svg>
              <span v-if="!collapsed" class="hidden lg:inline">{{ item.label }}</span>
            </router-link>
          </div>
        </section>
      </nav>

      <!-- 最近作品快捷列表 -->
      <div v-if="!collapsed" class="hidden lg:block mx-2.5 pt-4 pb-3 border-t" :style="{ borderTopColor: 'var(--border-clr)' }">
        <div class="px-3 pb-2 text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">
          最近作品
        </div>
        <div class="space-y-0.5">
          <button
            v-for="book in recentBooks"
            :key="book.id"
            type="button"
            :title="book.title"
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
    </div>

    <!-- User & Theme Toggle -->
    <div class="border-t p-2.5 space-y-1 shrink-0"
      :style="{ borderTopColor: 'var(--border-clr)' }">
      <div v-if="!collapsed" class="hidden lg:flex items-center gap-2.5 mb-2 px-1.5">
        <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
          :style="{ backgroundColor: 'var(--ink)', color: 'var(--ink-text)' }">
          {{ (authStore.user?.name || 'U')[0].toUpperCase() }}
        </div>
        <span class="text-sm truncate flex-1" :style="{ color: 'var(--text-primary)' }">{{ authStore.user?.name || '用户' }}</span>
      </div>

      <!-- Dark mode toggle -->
      <button type="button" @click="themeStore.toggle()"
        :aria-label="themeStore.isDark ? '切换浅色模式' : '切换深色模式'"
        :title="themeStore.isDark ? '浅色模式' : '深色模式'"
        class="sidebar-action w-full flex min-h-11 items-center justify-center gap-2.5 px-2 py-2 rounded-xl text-sm transition-colors duration-150 hover:bg-[var(--surface-hover)]"
        :style="{ color: 'var(--text-secondary)' }">
        <svg v-if="themeStore.isDark" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        <svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
        <span v-if="!collapsed" class="hidden lg:inline">{{ themeStore.isDark ? '浅色模式' : '深色模式' }}</span>
      </button>

      <button type="button" @click="handleLogout" aria-label="退出登录" title="退出登录"
        class="sidebar-action w-full flex min-h-11 items-center justify-center gap-2.5 px-2 py-2 text-sm rounded-xl transition-colors duration-150 hover:bg-[var(--surface-hover)]"
        :style="{ color: 'var(--text-muted)' }">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" x2="9" y1="12" y2="12" />
        </svg>
        <span v-if="!collapsed" class="hidden lg:inline">退出登录</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.app-sidebar svg {
  flex-shrink: 0;
}

.app-sidebar :is(a, button):focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: -2px;
}

.sidebar-nav-group + .sidebar-nav-group {
  padding-top: 1rem;
  border-top: 1px solid var(--border-clr);
}

@media (min-width: 1024px) {
  .sidebar-expanded {
    width: 14rem;
  }

  .sidebar-expanded .sidebar-header {
    justify-content: space-between;
    padding-inline: 0.75rem;
  }

  .sidebar-expanded .sidebar-action {
    justify-content: flex-start;
    padding-inline: 0.75rem;
  }
}
</style>
