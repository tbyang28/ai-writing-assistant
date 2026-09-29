<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBookStore, type Book } from '@/stores/book'
import { useCountUp } from '@/composables/useCountUp'
import { vSpotlight } from '@/composables/useCursorFx'

const router = useRouter()
const authStore = useAuthStore()
const bookStore = useBookStore()

const user = computed(() => authStore.user)
const isSeedingDemo = ref(false)
const seedError = ref('')

const totalChapters = computed(() => bookStore.stats?.totalChapters || 0)
const totalWords = computed(() => bookStore.stats?.totalWords || 0)
const todayWords = computed(() => bookStore.writingStats?.today_word_count || 0)
const streakDays = computed(() => bookStore.writingStats?.streak_days || 0)
const latestBook = computed(() => bookStore.books[0] || null)
const hasBooks = computed(() => bookStore.books.length > 0)
const chartDays = computed(() => bookStore.writingStats?.last_7_days || [])
const maxChartWords = computed(() => Math.max(...chartDays.value.map((day: any) => day.wordCount || 0), 1))

// 统计数字滚动动画
const animTotalBooks = useCountUp(() => bookStore.stats?.totalBooks || 0)
const animTotalWords = useCountUp(() => totalWords.value)
const animTotalChapters = useCountUp(() => totalChapters.value)
const animStreakDays = useCountUp(() => streakDays.value)

onMounted(async () => {
  try {
    await Promise.all([
      bookStore.fetchBooks(),
      bookStore.fetchStats(),
      bookStore.fetchWritingStats(),
    ])
  } catch (err) {
    console.error('加载数据失败:', err)
  }
})

function openBook(book: Book) {
  router.push(`/editor/${book.id}`)
}

async function seedDemoBook() {
  seedError.value = ''
  isSeedingDemo.value = true
  try {
    const book = await bookStore.seedDemoBook()
    if (!book?.id) throw new Error('初始化示例作品后未找到作品 ID，请刷新后重试')
    await router.push(`/editor/${book.id}`)
  } catch (err: any) {
    seedError.value = err?.response?.data?.detail || err?.message || '初始化失败'
  } finally {
    isSeedingDemo.value = false
  }
}

function formatWordCount(count?: number | null) {
  if (!count) return '0'
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}

function formatDateLabel(dateText: string) {
  if (!dateText) return ''
  const date = new Date(dateText)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
}
</script>

<template>
  <div class="flex-1 min-h-0 overflow-auto">
    <div class="min-h-full" :style="{ backgroundColor: 'var(--bg-page)' }">
      <div class="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <!-- Loading -->
        <div v-if="bookStore.isLoading" class="py-16 text-center" :style="{ color: 'var(--text-muted)' }">
          <div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          加载中...
        </div>

        <template v-else>
          <!-- 问候区 -->
          <header class="pt-4 pb-2 animate-fade-up">
            <div class="eyebrow flex items-center gap-2">
              <span class="h-1.5 w-1.5 rounded-full bg-brand inline-block"></span>
              Writing Workspace
            </div>
            <h1 class="mt-4 font-serif text-4xl lg:text-5xl font-semibold leading-tight"
              :style="{ color: 'var(--text-primary)' }">
              {{ greeting() }}，{{ user?.name || '作者' }}
            </h1>
            <p class="mt-3 text-[15px] leading-7 max-w-2xl" :style="{ color: 'var(--text-secondary)' }">
              今天也写一点吧。{{ streakDays > 0 ? `你已经连续创作 ${streakDays} 天。` : '从现在开始，积累你的第一天。' }}
            </p>
            <div class="mt-6 flex flex-wrap gap-2.5">
              <button v-if="latestBook" @click="openBook(latestBook)" class="btn-primary">
                继续《{{ latestBook.title }}》
              </button>
              <button v-else @click="seedDemoBook" :disabled="isSeedingDemo" class="btn-accent">
                {{ isSeedingDemo ? '初始化中...' : '初始化示例作品' }}
              </button>
              <button @click="router.push('/books')" class="btn-secondary">
                {{ hasBooks ? '管理作品' : '新建作品' }}
              </button>
            </div>
            <div v-if="seedError" class="mt-3 rounded-xl px-4 py-2.5 text-sm"
              :style="{ backgroundColor: '#f9e3dd', color: '#a0432c' }">
              {{ seedError }}
            </div>
          </header>

          <!-- 统计数字 -->
          <section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div v-for="(stat, i) in [
              { label: '作品总数', value: animTotalBooks },
              { label: '累计字数', value: formatWordCount(animTotalWords) },
              { label: '章节沉淀', value: animTotalChapters },
              { label: '连续创作', value: `${animStreakDays} 天` },
            ]" :key="stat.label"
              v-spotlight
              class="card px-5 py-4 animate-fade-up"
              :class="`stagger-${i + 1}`">
              <div class="font-serif text-3xl font-semibold" :style="{ color: 'var(--text-primary)' }">{{ stat.value }}</div>
              <div class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">{{ stat.label }}</div>
            </div>
          </section>

          <!-- 写作趋势 -->
          <section class="card p-5 animate-fade-up stagger-3">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold" :style="{ color: 'var(--text-primary)' }">本周写作趋势</h2>
                <p class="text-xs mt-1" :style="{ color: 'var(--text-muted)' }">今日新增 {{ formatWordCount(todayWords) }} 字</p>
              </div>
              <div class="rounded-full px-3 py-1 text-xs font-medium"
                :style="{ backgroundColor: 'var(--brand-soft)', color: 'var(--brand-hover)' }">
                {{ streakDays }} 天连续
              </div>
            </div>
            <div class="mt-5 h-44 flex items-end gap-3">
              <div v-for="(day, i) in chartDays" :key="day.date" class="flex-1 flex flex-col items-center gap-2">
                <div class="w-full max-w-14 rounded-t-md bg-brand min-h-[6px] animate-bar-grow"
                  :class="(day.wordCount || 0) > 0 ? 'opacity-100' : 'opacity-25'"
                  :style="{ height: `${Math.max(6, ((day.wordCount || 0) / maxChartWords) * 140)}px`, animationDelay: `${i * 60}ms` }"></div>
                <div class="text-[11px]" :style="{ color: 'var(--text-muted)' }">{{ formatDateLabel(day.date) }}</div>
              </div>
            </div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>
