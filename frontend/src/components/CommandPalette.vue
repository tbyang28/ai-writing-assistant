<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { useBookStore } from '@/stores/book'

interface Command {
  id: string
  title: string
  hint?: string
  run: () => void | Promise<void>
}

const router = useRouter()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const bookStore = useBookStore()

const open = ref(false)
const keyword = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)

const commands = computed<Command[]>(() => {
  const base: Command[] = [
    { id: 'nav-home', title: '工作台', hint: '/home', run: () => router.push('/home') },
    { id: 'nav-books', title: '我的作品', hint: '/books', run: () => router.push('/books') },
    { id: 'nav-inspirations', title: '灵感库', hint: '/inspirations', run: () => router.push('/inspirations') },
    { id: 'nav-stats', title: '写作统计', hint: '/stats', run: () => router.push('/stats') },
    { id: 'theme', title: themeStore.isDark ? '切换为浅色模式' : '切换为深色模式', hint: '主题', run: () => themeStore.toggle() },
    {
      id: 'logout',
      title: '退出登录',
      hint: authStore.user?.name,
      run: async () => {
        authStore.logout()
        await router.replace('/auth')
      },
    },
  ]
  const bookCmds: Command[] = bookStore.books.map((b) => ({
    id: `book-${b.id}`,
    title: `打开《${b.title}》`,
    hint: '编辑器',
    run: async () => { await router.push(`/editor/${b.id}`) },
  }))
  return [...base, ...bookCmds]
})

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return commands.value
  return commands.value.filter((c) => c.title.toLowerCase().includes(k) || (c.hint || '').toLowerCase().includes(k))
})

watch(keyword, () => {
  activeIndex.value = 0
})

function openPalette() {
  open.value = true
  keyword.value = ''
  activeIndex.value = 0
  if (!bookStore.books.length) {
    bookStore.fetchBooks().catch(() => {})
  }
  nextTick(() => inputRef.value?.focus())
}

function closePalette() {
  open.value = false
}

async function execute(cmd: Command) {
  closePalette()
  await cmd.run()
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    open.value ? closePalette() : openPalette()
    return
  }
  if (!open.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    closePalette()
  } else if (e.key === 'Tab') {
    // 轻量 focus trap：焦点锁在面板输入框，不逃逸到页面下层
    e.preventDefault()
    inputRef.value?.focus()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, filtered.value.length - 1)
    scrollActiveIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
    scrollActiveIntoView()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const cmd = filtered.value[activeIndex.value]
    if (cmd) execute(cmd)
  }
}

function scrollActiveIntoView() {
  nextTick(() => {
    listRef.value?.children[activeIndex.value]?.scrollIntoView({ block: 'nearest' })
  })
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="page-fade">
      <div v-if="open" class="modal-overlay !items-start pt-[14vh]" @mousedown.self="closePalette">
        <div class="w-full max-w-lg mx-auto px-4">
          <div class="card !p-0 overflow-hidden animate-pop-in" role="dialog" aria-label="命令面板">
            <div class="flex items-center gap-3 px-4 py-3 border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" :stroke="'var(--text-muted)'" stroke-width="2" stroke-linecap="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input ref="inputRef" v-model="keyword" type="text"
                class="flex-1 bg-transparent outline-none text-sm"
                :style="{ color: 'var(--text-primary)' }"
                placeholder="输入命令或搜索作品…" />
              <kbd class="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                :style="{ backgroundColor: 'var(--surface-secondary)', color: 'var(--text-muted)' }">ESC</kbd>
            </div>
            <div ref="listRef" class="max-h-[46vh] overflow-y-auto py-1.5">
              <button v-for="(cmd, i) in filtered" :key="cmd.id"
                @click="execute(cmd)"
                @mouseenter="activeIndex = i"
                class="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors duration-100"
                :style="i === activeIndex
                  ? { backgroundColor: 'var(--brand-soft)', color: 'var(--brand-hover)' }
                  : { color: 'var(--text-primary)' }">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 opacity-70">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <span class="flex-1 truncate">{{ cmd.title }}</span>
                <span v-if="cmd.hint" class="text-[11px] shrink-0" :style="{ color: 'var(--text-muted)' }">{{ cmd.hint }}</span>
              </button>
              <div v-if="!filtered.length" class="px-4 py-8 text-center text-sm" :style="{ color: 'var(--text-muted)' }">
                没有匹配的命令
              </div>
            </div>
            <div class="flex items-center gap-4 px-4 py-2 border-t text-[11px]"
              :style="{ borderTopColor: 'var(--border-clr)', color: 'var(--text-muted)' }">
              <span>↑↓ 选择</span>
              <span>↵ 执行</span>
              <span class="ml-auto">⌘K 随时唤起</span>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
