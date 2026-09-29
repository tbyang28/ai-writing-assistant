<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet } from '@/api'
import { vSpotlight } from '@/composables/useCursorFx'
import { vReveal } from '@/composables/useReveal'

interface InspirationItem {
  id: string
  title: string
  content: string
  tags: string
  book_id: string
  book_title: string
  created_at: string
}

const router = useRouter()
const items = ref<InspirationItem[]>([])
const isLoading = ref(true)
const keyword = ref('')

const filteredItems = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((item) =>
    item.title.toLowerCase().includes(k)
    || item.content.toLowerCase().includes(k)
    || (item.book_title || '').toLowerCase().includes(k)
    || parseTags(item.tags).some((t) => t.toLowerCase().includes(k)))
})

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function formatDate(text: string) {
  if (!text) return ''
  const d = new Date(text)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

onMounted(async () => {
  try {
    items.value = await apiGet<InspirationItem[]>('/inspirations')
  } catch (err) {
    console.error('加载灵感失败:', err)
  } finally {
    isLoading.value = false
  }
})
</script>

<template>
  <div class="flex-1 min-h-0 overflow-auto">
    <div class="min-h-full" :style="{ backgroundColor: 'var(--bg-page)' }">
      <div class="max-w-6xl mx-auto px-6 py-8">
        <header class="pt-4 pb-2 animate-fade-up">
          <div class="eyebrow flex items-center gap-2">
            <span class="h-1.5 w-1.5 rounded-full bg-brand inline-block"></span>
            Inspirations
          </div>
          <h1 class="mt-4 font-serif text-4xl font-semibold leading-tight" :style="{ color: 'var(--text-primary)' }">灵感库</h1>
          <p class="mt-2 text-[15px] leading-7 max-w-2xl" :style="{ color: 'var(--text-secondary)' }">
            散落在各部作品里的灵感碎片，全部收在这里。写作时随手记，卡文时来回看。
          </p>
          <div v-if="items.length > 4" class="mt-6 relative max-w-sm">
            <svg class="absolute left-3.5 top-1/2 -translate-y-1/2" width="15" height="15" viewBox="0 0 24 24" fill="none"
              :stroke="'var(--text-muted)'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3"/>
            </svg>
            <input v-model="keyword" type="text" class="form-input !pl-10" placeholder="搜索灵感、标签或作品名" />
          </div>
        </header>

        <div v-if="isLoading" class="py-16 text-center" :style="{ color: 'var(--text-muted)' }">
          <div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          加载中...
        </div>

        <div v-else-if="filteredItems.length" class="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="(item, idx) in filteredItems" :key="item.id"
            v-spotlight
            class="card p-5 hover-lift animate-fade-up"
            :class="`stagger-${(idx % 6) + 1}`">
            <div class="flex items-center justify-between gap-2">
              <button @click="router.push(`/editor/${item.book_id}`)"
                class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 hover:brightness-95"
                :style="{ backgroundColor: 'var(--brand-soft)', color: 'var(--brand-hover)' }">
                《{{ item.book_title }}》
              </button>
              <span class="text-[11px]" :style="{ color: 'var(--text-muted)' }">{{ formatDate(item.created_at) }}</span>
            </div>
            <h3 class="mt-3 font-serif text-[16px] font-semibold" :style="{ color: 'var(--text-primary)' }">{{ item.title }}</h3>
            <p class="mt-2 text-[13px] leading-6 whitespace-pre-wrap" :style="{ color: 'var(--text-secondary)' }">{{ item.content }}</p>
            <div v-if="parseTags(item.tags).length" class="mt-3.5 flex flex-wrap gap-1.5">
              <span v-for="tag in parseTags(item.tags)" :key="tag"
                class="rounded-md px-2 py-0.5 text-[11px]"
                :style="{ backgroundColor: 'var(--surface-secondary)', color: 'var(--text-secondary)' }">
                {{ tag }}
              </span>
            </div>
          </div>
        </div>

        <div v-else v-reveal class="mt-6 card p-12 text-center">
          <h3 class="font-serif font-semibold text-xl" :style="{ color: 'var(--text-primary)' }">
            {{ keyword ? '没有匹配的灵感' : '灵感库还是空的' }}
          </h3>
          <p class="mt-2 text-sm max-w-md mx-auto leading-6" :style="{ color: 'var(--text-muted)' }">
            {{ keyword ? '换个关键词试试。' : '在编辑器里打开任意作品，写作时随手把灵感记录下来，它们会自动聚合到这里。' }}
          </p>
          <button v-if="!keyword" @click="router.push('/books')" class="btn-primary mt-6 text-sm">
            去选一部作品
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
