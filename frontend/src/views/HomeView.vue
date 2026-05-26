<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBookStore, type Book } from '@/stores/book'

const router = useRouter()
const authStore = useAuthStore()
const bookStore = useBookStore()

const user = computed(() => authStore.user)
const showNewBookModal = ref(false)
const newBookTitle = ref('')
const newBookDescription = ref('')
const isCreating = ref(false)
const createError = ref('')

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

async function createNewBook() {
  if (!newBookTitle.value.trim()) return
  createError.value = ''
  isCreating.value = true
  try {
    const book = await bookStore.createBook({
      title: newBookTitle.value.trim(),
      description: newBookDescription.value.trim() || undefined,
    })
    showNewBookModal.value = false
    newBookTitle.value = ''
    newBookDescription.value = ''
    router.push(`/editor/${book.id}`)
  } catch (err: any) {
    createError.value = err?.response?.data?.detail || err?.message || '创建失败'
  } finally {
    isCreating.value = false
  }
}

function openBook(book: Book) {
  router.push(`/editor/${book.id}`)
}

async function deleteBook(book: Book, event: Event) {
  event.stopPropagation()
  if (!confirm(`确定删除《${book.title}》吗？此操作无法撤销。`)) return
  try {
    await bookStore.deleteBook(book.id)
    await Promise.all([bookStore.fetchStats(), bookStore.fetchWritingStats()])
  } catch (err: any) {
    alert('删除失败')
  }
}

function getStatusLabel(status: string) {
  return ({ DRAFT: '草稿', SERIAL: '连载中', FINISHED: '已完结' } as any)[status] || status
}

function formatWordCount(count?: number | null) {
  if (!count) return '0'
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0 overflow-hidden">

    <!-- Header -->
    <div :style="{ backgroundColor: 'var(--surface)', borderBottomColor: 'var(--border-clr)' }" class="border-b">
      <div class="max-w-6xl mx-auto px-6 py-6">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-bold" :style="{ color: 'var(--text-primary)' }">
              欢迎回来，{{ user?.name || '作者' }}
            </h1>
            <p class="text-sm mt-1" :style="{ color: 'var(--text-muted)' }">与世界分享你的故事</p>
          </div>

          <!-- Stats -->
          <div v-if="bookStore.stats && bookStore.writingStats" class="flex gap-4">
            <div class="rounded-xl px-4 py-3 text-center min-w-[80px]" :style="{ backgroundColor: 'var(--surface-secondary)' }">
              <div class="text-xl font-bold text-brand">{{ bookStore.stats.totalBooks }}</div>
              <div class="text-xs" :style="{ color: 'var(--text-muted)' }">作品总数</div>
            </div>
            <div class="rounded-xl px-4 py-3 text-center min-w-[80px]" :style="{ backgroundColor: 'var(--surface-secondary)' }">
              <div class="text-xl font-bold text-green-500">{{ formatWordCount(bookStore.writingStats.today_word_count) }}</div>
              <div class="text-xs" :style="{ color: 'var(--text-muted)' }">今日字数</div>
            </div>
            <div class="rounded-xl px-4 py-3 text-center min-w-[80px]" :style="{ backgroundColor: 'var(--surface-secondary)' }">
              <div class="text-xl font-bold text-indigo-500">{{ bookStore.writingStats.streak_days }}</div>
              <div class="text-xs" :style="{ color: 'var(--text-muted)' }">连续天数</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Toolbar -->
    <div :style="{ backgroundColor: 'var(--surface)', borderBottomColor: 'var(--border-clr)' }" class="border-b">
      <div class="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <button @click="showNewBookModal = true" class="btn-primary flex items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
          </svg>
          新建作品
        </button>
      </div>
    </div>

    <!-- Book Grid -->
    <div class="flex-1 overflow-auto">
      <div class="max-w-6xl mx-auto px-6 py-6">
        <!-- Loading -->
        <div v-if="bookStore.isLoading" class="py-16 text-center" :style="{ color: 'var(--text-muted)' }">
          <div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          加载中...
        </div>

        <!-- Books -->
        <div v-else-if="bookStore.books.length > 0" class="grid gap-5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          <div v-for="book in bookStore.books" :key="book.id" @click="openBook(book)" class="group cursor-pointer">
            <div class="aspect-[3/4] rounded-lg overflow-hidden relative shadow-sm bg-gradient-to-br from-brand-50 to-blue-100 dark:from-brand-900/30 dark:to-blue-900/30 flex items-center justify-center border"
              :style="{ borderColor: 'var(--border-clr)' }">
              <span class="text-gray-300 dark:text-gray-600 text-5xl font-serif">{{ book.title.charAt(0) }}</span>

              <span class="absolute top-2 left-2 px-2 py-0.5 text-xs rounded font-medium text-white"
                :class="{ 'bg-gray-400': book.status === 'DRAFT', 'bg-green-500': book.status === 'SERIAL', 'bg-indigo-500': book.status === 'FINISHED' }">
                {{ getStatusLabel(book.status) }}
              </span>

              <button @click="deleteBook(book, $event)"
                class="absolute top-2 right-2 w-6 h-6 flex items-center justify-center bg-black/40 hover:bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity text-xs">
                ✕
              </button>
            </div>
            <div class="mt-2.5">
              <h3 class="text-sm font-medium truncate" :style="{ color: 'var(--text-primary)' }">{{ book.title }}</h3>
              <div class="flex items-center gap-2 mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">
                <span>{{ formatWordCount(book.word_count) }}字</span>
                <span v-if="book.chapters?.length">{{ book.chapters.length }}章</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Empty -->
        <div v-else class="text-center py-20">
          <div class="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center"
            :style="{ backgroundColor: 'var(--surface-secondary)' }">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"
              :style="{ color: 'var(--text-muted)' }">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
            </svg>
          </div>
          <h2 class="text-lg font-semibold mb-2" :style="{ color: 'var(--text-primary)' }">暂无作品</h2>
          <p class="text-sm mb-6" :style="{ color: 'var(--text-muted)' }">点击"新建作品"开始你的第一部作品</p>
          <button @click="showNewBookModal = true" class="btn-primary">创建作品</button>
        </div>
      </div>
    </div>

    <!-- New Book Modal -->
    <div v-if="showNewBookModal" class="modal-overlay" @click.self="showNewBookModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-5" :style="{ color: 'var(--text-primary)' }">新建作品</h3>
        <div class="space-y-4">
          <div>
            <label class="form-label">作品标题 <span class="text-red-500">*</span></label>
            <input v-model="newBookTitle" type="text" class="form-input" placeholder="请输入作品标题" @keyup.enter="createNewBook" />
          </div>
          <div>
            <label class="form-label">作品简介</label>
            <textarea v-model="newBookDescription" rows="3" class="form-textarea" placeholder="简介（可选）" />
          </div>
          <div v-if="createError" class="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">{{ createError }}</div>
        </div>
        <div class="flex justify-end gap-3 mt-6">
          <button @click="showNewBookModal = false; newBookTitle = ''; newBookDescription = ''; createError = ''" class="btn-secondary">取消</button>
          <button @click="createNewBook" :disabled="!newBookTitle.trim() || isCreating" class="btn-primary disabled:opacity-50">
            {{ isCreating ? '创建中...' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
