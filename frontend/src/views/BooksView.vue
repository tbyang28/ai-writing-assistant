<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useBookStore, type Book } from '@/stores/book'
import { vReveal } from '@/composables/useReveal'
import { vSpotlight } from '@/composables/useCursorFx'

const router = useRouter()
const bookStore = useBookStore()

const keyword = ref('')
const showNewBookModal = ref(false)
const newBookTitle = ref('')
const newBookDescription = ref('')
const isCreating = ref(false)
const createError = ref('')
const isSeedingDemo = ref(false)
const seedError = ref('')

const filteredBooks = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return bookStore.books
  return bookStore.books.filter((b) =>
    b.title.toLowerCase().includes(k) || (b.description || '').toLowerCase().includes(k))
})

onMounted(async () => {
  try {
    await bookStore.fetchBooks()
  } catch (err) {
    console.error('加载作品失败:', err)
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
    if (!book?.id) throw new Error('创建作品后未找到作品 ID，请刷新后重试')
    showNewBookModal.value = false
    newBookTitle.value = ''
    newBookDescription.value = ''
    await router.push(`/editor/${book.id}`)
  } catch (err: any) {
    createError.value = err?.response?.data?.detail || err?.message || '创建失败'
  } finally {
    isCreating.value = false
  }
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

function openBook(book: Book) {
  router.push(`/editor/${book.id}`)
}

async function deleteBook(book: Book, event: Event) {
  event.stopPropagation()
  if (!confirm(`确定删除《${book.title}》吗？此操作无法撤销。`)) return
  try {
    await bookStore.deleteBook(book.id)
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
  <div class="flex-1 min-h-0 overflow-auto">
    <div class="min-h-full" :style="{ backgroundColor: 'var(--bg-page)' }">
      <div class="max-w-6xl mx-auto px-6 py-8">
        <!-- 页头 -->
        <header class="pt-4 pb-2 animate-fade-up">
          <div class="eyebrow flex items-center gap-2">
            <span class="h-1.5 w-1.5 rounded-full bg-brand inline-block"></span>
            Library
          </div>
          <div class="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 class="font-serif text-4xl font-semibold leading-tight" :style="{ color: 'var(--text-primary)' }">我的作品</h1>
              <p class="mt-2 text-[15px]" :style="{ color: 'var(--text-secondary)' }">
                共 {{ bookStore.books.length }} 部，选择一部进入写作工作台。
              </p>
            </div>
            <div class="flex flex-wrap gap-2.5">
              <button @click="seedDemoBook" :disabled="isSeedingDemo" class="btn-accent">
                {{ isSeedingDemo ? '初始化中...' : '初始化示例作品' }}
              </button>
              <button @click="showNewBookModal = true" class="btn-primary">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M12 4.5v15m7.5-7.5h-15"/>
                </svg>
                新建作品
              </button>
            </div>
          </div>
          <div v-if="seedError" class="mt-3 rounded-xl px-4 py-2.5 text-sm"
            :style="{ backgroundColor: '#f9e3dd', color: '#a0432c' }">
            {{ seedError }}
          </div>

          <!-- 搜索 -->
          <div v-if="bookStore.books.length > 3" class="mt-6 relative max-w-sm">
            <svg class="absolute left-3.5 top-1/2 -translate-y-1/2" width="15" height="15" viewBox="0 0 24 24" fill="none"
              :stroke="'var(--text-muted)'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3"/>
            </svg>
            <input v-model="keyword" type="text" class="form-input !pl-10" placeholder="搜索作品标题或简介" />
          </div>
        </header>

        <!-- 加载态 -->
        <div v-if="bookStore.isLoading" class="py-16 text-center" :style="{ color: 'var(--text-muted)' }">
          <div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          加载中...
        </div>

        <!-- 作品网格 -->
        <div v-else-if="filteredBooks.length" class="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="book in filteredBooks" :key="book.id" @click="openBook(book)"
            v-spotlight
            class="group cursor-pointer card p-5 transition-all duration-150 hover:border-brand hover:-translate-y-0.5">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="font-serif font-semibold text-lg truncate" :style="{ color: 'var(--text-primary)' }">{{ book.title }}</div>
                <div class="mt-2 flex flex-wrap items-center gap-2 text-xs" :style="{ color: 'var(--text-muted)' }">
                  <span>{{ formatWordCount(book.word_count) }} 字</span>
                  <span class="rounded-full px-2 py-0.5"
                    :style="{ backgroundColor: 'var(--surface-secondary)', color: 'var(--text-secondary)' }">
                    {{ getStatusLabel(book.status) }}
                  </span>
                </div>
              </div>
              <button @click="deleteBook(book, $event)"
                class="shrink-0 h-7 w-7 rounded-lg text-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--surface-hover)] hover:text-[#a0432c]"
                :style="{ color: 'var(--text-muted)' }">
                ✕
              </button>
            </div>
            <p class="mt-3 line-clamp-3 text-[13.5px] leading-6" :style="{ color: 'var(--text-secondary)' }">
              {{ book.description || '暂无简介，进入编辑器继续完善作品设定。' }}
            </p>
            <div class="mt-4 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
              :style="{ color: 'var(--brand-hover)' }">
              进入编辑器 →
            </div>
          </div>
        </div>

        <!-- 空态 -->
        <div v-else v-reveal class="mt-6 card p-12 text-center">
          <h3 class="font-serif font-semibold text-xl" :style="{ color: 'var(--text-primary)' }">
            {{ keyword ? '没有匹配的作品' : '还没有作品' }}
          </h3>
          <p class="mt-2 text-sm" :style="{ color: 'var(--text-muted)' }">
            {{ keyword ? '换个关键词试试。' : '创建第一部作品，开始管理章节、角色和创作进度。' }}
          </p>
          <div v-if="!keyword" class="mt-6 flex flex-wrap justify-center gap-2.5">
            <button @click="seedDemoBook" :disabled="isSeedingDemo" class="btn-accent">
              {{ isSeedingDemo ? '初始化中...' : '初始化示例作品' }}
            </button>
            <button @click="showNewBookModal = true" class="btn-secondary">创建空白作品</button>
          </div>
        </div>
      </div>
    </div>

    <!-- New Book Modal -->
    <div v-if="showNewBookModal" class="modal-overlay animate-fade-in" @click.self="showNewBookModal = false">
      <div class="modal-content animate-pop-in">
        <h3 class="font-serif text-xl font-semibold mb-5" :style="{ color: 'var(--text-primary)' }">新建作品</h3>
        <div class="space-y-4">
          <div>
            <label class="form-label">作品标题 <span :style="{ color: '#a0432c' }">*</span></label>
            <input v-model="newBookTitle" type="text" class="form-input" placeholder="请输入作品标题" @keyup.enter="createNewBook" />
          </div>
          <div>
            <label class="form-label">作品简介</label>
            <textarea v-model="newBookDescription" rows="3" class="form-textarea" placeholder="简介（可选）" />
          </div>
          <div v-if="createError" class="text-sm px-3 py-2 rounded-lg" :style="{ backgroundColor: '#f9e3dd', color: '#a0432c' }">{{ createError }}</div>
        </div>
        <div class="flex justify-end gap-3 mt-6">
          <button @click="showNewBookModal = false; newBookTitle = ''; newBookDescription = ''; createError = ''" class="btn-secondary">取消</button>
          <button @click="createNewBook" :disabled="!newBookTitle.trim() || isCreating" class="btn-primary">
            {{ isCreating ? '创建中...' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
