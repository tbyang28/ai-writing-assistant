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
const isSeedingDemo = ref(false)
const seedError = ref('')

const totalChapters = computed(() => bookStore.stats?.totalChapters || 0)
const totalWords = computed(() => bookStore.stats?.totalWords || 0)
const todayWords = computed(() => bookStore.writingStats?.today_word_count || 0)
const streakDays = computed(() => bookStore.writingStats?.streak_days || 0)
const recentBooks = computed(() => bookStore.books.slice(0, 4))
const latestBook = computed(() => bookStore.books[0] || null)
const chartDays = computed(() => bookStore.writingStats?.last_7_days || [])
const maxChartWords = computed(() => Math.max(...chartDays.value.map((day: any) => day.wordCount || 0), 1))

const quickTools = [
  { title: '继续写作', desc: '打开最近作品，继续完善当前章节', metric: '01' },
  { title: '润色校对', desc: '检查表达、错别字和不自然语句', metric: '02' },
  { title: '整理人物', desc: '从章节中识别人物，沉淀到角色库', metric: '03' },
  { title: '查看图谱', desc: '梳理人物关系、阵营和剧情冲突', metric: '04' },
]

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
    await Promise.all([bookStore.fetchStats(), bookStore.fetchWritingStats()])
  } catch (err: any) {
    alert('删除失败')
  }
}

async function logout() {
  authStore.logout()
  await router.replace('/auth')
}

function getStatusLabel(status: string) {
  return ({ DRAFT: '草稿', SERIAL: '连载中', FINISHED: '已完结' } as any)[status] || status
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
          <!-- 问候区：Claude 式大衬线标题 -->
          <header class="pt-4 pb-2">
            <div class="eyebrow flex items-center gap-2">
              <span class="h-1.5 w-1.5 rounded-full bg-brand inline-block"></span>
              Writing Workspace
            </div>
            <h1 class="mt-4 font-serif text-4xl lg:text-5xl font-semibold leading-tight"
              :style="{ color: 'var(--text-primary)' }">
              欢迎回来，{{ user?.name || '作者' }}
            </h1>
            <p class="mt-3 text-[15px] leading-7 max-w-2xl" :style="{ color: 'var(--text-secondary)' }">
              管理作品、追踪写作进度，并在需要时使用 AI 辅助润色、续写和整理角色。
            </p>
            <div class="mt-6 flex flex-wrap gap-2.5">
              <button v-if="latestBook" @click="openBook(latestBook)" class="btn-primary">
                继续《{{ latestBook.title }}》
              </button>
              <button @click="showNewBookModal = true" class="btn-secondary">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M12 4.5v15m7.5-7.5h-15"/>
                </svg>
                新建作品
              </button>
              <button @click="seedDemoBook" :disabled="isSeedingDemo" class="btn-accent">
                {{ isSeedingDemo ? '初始化中...' : '初始化示例作品' }}
              </button>
              <button @click="logout" class="btn-ghost ml-auto">
                退出登录
              </button>
            </div>
            <div v-if="seedError" class="mt-3 rounded-xl px-4 py-2.5 text-sm"
              :style="{ backgroundColor: '#f9e3dd', color: '#a0432c' }">
              {{ seedError }}
            </div>
          </header>

          <!-- 统计 + 趋势 -->
          <section class="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
            <div class="grid grid-cols-2 gap-4">
              <div v-for="stat in [
                { label: '作品总数', value: bookStore.stats?.totalBooks || 0 },
                { label: '累计字数', value: formatWordCount(totalWords) },
                { label: '章节沉淀', value: totalChapters },
                { label: '连续创作', value: `${streakDays} 天` },
              ]" :key="stat.label"
                class="card px-5 py-4">
                <div class="font-serif text-3xl font-semibold" :style="{ color: 'var(--text-primary)' }">{{ stat.value }}</div>
                <div class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">{{ stat.label }}</div>
              </div>
            </div>

            <div class="card p-5">
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
              <div class="mt-5 h-40 flex items-end gap-2.5">
                <div v-for="day in chartDays" :key="day.date" class="flex-1 flex flex-col items-center gap-2">
                  <div class="w-full rounded-t-md bg-brand transition-all min-h-[6px]"
                    :class="(day.wordCount || 0) > 0 ? 'opacity-100' : 'opacity-25'"
                    :style="{ height: `${Math.max(6, ((day.wordCount || 0) / maxChartWords) * 124)}px` }"></div>
                  <div class="text-[11px]" :style="{ color: 'var(--text-muted)' }">{{ formatDateLabel(day.date) }}</div>
                </div>
              </div>
            </div>
          </section>

          <!-- 工具与最近作品 -->
          <section class="grid gap-5 xl:grid-cols-[1fr_330px]">
            <div class="space-y-4">
              <div>
                <h2 class="text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">常用工具</h2>
                <p class="text-sm mt-1" :style="{ color: 'var(--text-muted)' }">围绕日常写作流程整理的快捷能力。</p>
              </div>

              <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div v-for="item in quickTools" :key="item.title"
                  class="card p-4 transition-all duration-150 hover:-translate-y-0.5"
                  :style="{ '--shadow-hover': 'var(--shadow-lift)' }">
                  <div class="h-9 w-9 rounded-lg flex items-center justify-center font-serif text-sm font-semibold"
                    :style="{ backgroundColor: 'var(--brand-soft)', color: 'var(--brand-hover)' }">
                    {{ item.metric }}
                  </div>
                  <h3 class="mt-3.5 text-[15px] font-semibold" :style="{ color: 'var(--text-primary)' }">{{ item.title }}</h3>
                  <p class="mt-1.5 text-[13px] leading-6" :style="{ color: 'var(--text-secondary)' }">{{ item.desc }}</p>
                </div>
              </div>

              <div class="card p-5">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <h2 class="text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">最近作品</h2>
                    <p class="text-sm mt-1" :style="{ color: 'var(--text-muted)' }">选择一个作品进入写作工作台。</p>
                  </div>
                  <button @click="showNewBookModal = true" class="btn-secondary text-xs px-3 py-1.5">新建</button>
                </div>

                <div v-if="recentBooks.length" class="mt-4 grid gap-3 md:grid-cols-2">
                  <div v-for="book in recentBooks" :key="book.id" @click="openBook(book)"
                    class="group cursor-pointer rounded-xl border p-4 transition-all duration-150 hover:border-brand"
                    :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface)' }">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="font-serif font-semibold text-[15px] truncate" :style="{ color: 'var(--text-primary)' }">{{ book.title }}</div>
                        <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs" :style="{ color: 'var(--text-muted)' }">
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
                    <p class="mt-2.5 line-clamp-2 text-[13px] leading-6" :style="{ color: 'var(--text-secondary)' }">
                      {{ book.description || '暂无简介，进入编辑器继续完善作品设定。' }}
                    </p>
                  </div>
                </div>

                <div v-else class="mt-4 rounded-xl border border-dashed p-8 text-center" :style="{ borderColor: 'var(--border-clr)' }">
                  <h3 class="font-serif font-semibold text-lg" :style="{ color: 'var(--text-primary)' }">还没有作品</h3>
                  <p class="mt-2 text-sm" :style="{ color: 'var(--text-muted)' }">创建第一部作品，开始管理章节、角色和创作进度。</p>
                  <div class="mt-5 flex flex-wrap justify-center gap-2.5">
                    <button @click="seedDemoBook" :disabled="isSeedingDemo" class="btn-accent">
                      {{ isSeedingDemo ? '初始化中...' : '初始化示例作品' }}
                    </button>
                    <button @click="showNewBookModal = true" class="btn-secondary">创建空白作品</button>
                  </div>
                  <p v-if="seedError" class="mt-3 text-sm" :style="{ color: '#a0432c' }">{{ seedError }}</p>
                </div>
              </div>
            </div>

            <aside class="space-y-4">
              <!-- 人物关系概览：暖色调迷你图谱 -->
              <div class="card overflow-hidden">
                <div class="p-5 border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
                  <div class="eyebrow">Story Map</div>
                  <h2 class="mt-2 font-serif text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">人物关系概览</h2>
                  <p class="mt-2 text-[13px] leading-6" :style="{ color: 'var(--text-secondary)' }">
                    把角色、阵营和关系沉淀下来，写长篇时随时回看设定。
                  </p>
                </div>
                <div class="relative h-64">
                  <svg viewBox="0 0 320 210" class="absolute inset-0 h-full w-full">
                    <line x1="160" y1="104" x2="84" y2="62" stroke="#448a6a" stroke-width="2.5" opacity="0.75" />
                    <line x1="160" y1="104" x2="246" y2="74" stroke="#c25344" stroke-width="2.5" opacity="0.75" />
                    <line x1="160" y1="104" x2="98" y2="162" stroke="#64829f" stroke-width="2" opacity="0.75" />
                    <line x1="160" y1="104" x2="232" y2="158" stroke="#c9974f" stroke-width="2" stroke-dasharray="6 6" opacity="0.75" />
                    <circle cx="160" cy="104" r="26" fill="#d97757" :stroke="'var(--surface)'" stroke-width="2.5" />
                    <circle cx="84" cy="62" r="20" fill="#448a6a" :stroke="'var(--surface)'" stroke-width="2.5" />
                    <circle cx="246" cy="74" r="20" fill="#c25344" :stroke="'var(--surface)'" stroke-width="2.5" />
                    <circle cx="98" cy="162" r="18" fill="#64829f" :stroke="'var(--surface)'" stroke-width="2.5" />
                    <circle cx="232" cy="158" r="18" fill="#c9974f" :stroke="'var(--surface)'" stroke-width="2.5" />
                    <text x="160" y="109" text-anchor="middle" fill="#fffdf8" font-size="11" font-weight="600">主角</text>
                    <text x="84" y="66" text-anchor="middle" fill="#fffdf8" font-size="10" font-weight="600">同伴</text>
                    <text x="246" y="78" text-anchor="middle" fill="#fffdf8" font-size="10" font-weight="600">反派</text>
                    <text x="98" y="166" text-anchor="middle" fill="#fffdf8" font-size="10" font-weight="600">导师</text>
                    <text x="232" y="162" text-anchor="middle" fill="#fffdf8" font-size="10" font-weight="600">伏笔</text>
                  </svg>
                </div>
              </div>

              <div class="card p-5">
                <h2 class="text-base font-semibold" :style="{ color: 'var(--text-primary)' }">今日写作建议</h2>
                <div class="mt-4 space-y-3.5">
                  <div v-for="(tip, i) in [
                    '先打开最近作品，补完当前章节的关键情节。',
                    '写完后用润色和校对检查语言问题。',
                    '新增角色后同步整理人物关系，保持设定一致。',
                  ]" :key="i" class="flex gap-3">
                    <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-serif text-xs font-semibold"
                      :style="{ backgroundColor: 'var(--ink)', color: 'var(--ink-text)' }">{{ i + 1 }}</span>
                    <p class="text-[13px] leading-6" :style="{ color: 'var(--text-secondary)' }">{{ tip }}</p>
                  </div>
                </div>
              </div>
            </aside>
          </section>
        </template>
      </div>
    </div>

    <!-- New Book Modal -->
    <div v-if="showNewBookModal" class="modal-overlay" @click.self="showNewBookModal = false">
      <div class="modal-content">
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
