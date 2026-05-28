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
  {
    title: '继续写作',
    desc: '打开最近作品，继续完善当前章节',
    accent: 'from-blue-500 to-cyan-400',
    metric: 'Write',
  },
  {
    title: '润色校对',
    desc: '检查表达、错别字和不自然语句',
    accent: 'from-emerald-500 to-teal-400',
    metric: 'Edit',
  },
  {
    title: '整理人物',
    desc: '从章节中识别人物，沉淀到角色库',
    accent: 'from-violet-500 to-fuchsia-400',
    metric: 'Role',
  },
  {
    title: '查看图谱',
    desc: '梳理人物关系、阵营和剧情冲突',
    accent: 'from-amber-500 to-orange-400',
    metric: 'Graph',
  },
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

async function seedDemoBook() {
  seedError.value = ''
  isSeedingDemo.value = true
  try {
    const book = await bookStore.seedDemoBook()
    router.push(`/editor/${book.id}`)
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
    <div class="min-h-full bg-[var(--bg-page)]">
      <div class="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <!-- Loading -->
        <div v-if="bookStore.isLoading" class="py-16 text-center" :style="{ color: 'var(--text-muted)' }">
          <div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          加载中...
        </div>

        <template v-else>
          <!-- Hero dashboard -->
          <section class="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
            <div class="relative overflow-hidden rounded-2xl bg-[#0f172a] text-white border border-white/10 shadow-sm">
              <div class="absolute inset-0 bg-[radial-gradient(circle_at_78%_22%,rgba(34,211,238,0.18),transparent_34%)]"></div>
              <div class="relative p-7 lg:p-8">
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div class="text-xs uppercase tracking-[0.18em] text-cyan-300">Writing Workspace</div>
                    <h1 class="mt-3 text-3xl lg:text-4xl font-semibold tracking-normal">
                      欢迎回来，{{ user?.name || '作者' }}
                    </h1>
                    <p class="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                      管理作品、追踪写作进度，并在需要时使用 AI 辅助润色、续写和整理角色。
                    </p>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button v-if="latestBook" @click="openBook(latestBook)" class="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-50 transition-colors">
                      继续《{{ latestBook.title }}》
                    </button>
                    <button @click="showNewBookModal = true" class="inline-flex items-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
                      </svg>
                      新建作品
                    </button>
                    <button
                      @click="seedDemoBook"
                      :disabled="isSeedingDemo"
                      class="inline-flex items-center gap-2 rounded-lg bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100 ring-1 ring-cyan-300/25 hover:bg-cyan-500/25 transition-colors disabled:opacity-60"
                    >
                      {{ isSeedingDemo ? '初始化中...' : '初始化示例作品' }}
                    </button>
                  </div>
                </div>
                <div v-if="seedError" class="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                  {{ seedError }}
                </div>

                <div class="mt-8 grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div class="rounded-xl border border-white/10 bg-white/8 px-4 py-3">
                    <div class="text-2xl font-semibold">{{ bookStore.stats?.totalBooks || 0 }}</div>
                    <div class="text-xs text-slate-300">作品总数</div>
                  </div>
                  <div class="rounded-xl border border-white/10 bg-white/8 px-4 py-3">
                    <div class="text-2xl font-semibold">{{ formatWordCount(totalWords) }}</div>
                    <div class="text-xs text-slate-300">累计字数</div>
                  </div>
                  <div class="rounded-xl border border-white/10 bg-white/8 px-4 py-3">
                    <div class="text-2xl font-semibold">{{ totalChapters }}</div>
                    <div class="text-xs text-slate-300">章节沉淀</div>
                  </div>
                  <div class="rounded-xl border border-white/10 bg-white/8 px-4 py-3">
                    <div class="text-2xl font-semibold">{{ streakDays }}</div>
                    <div class="text-xs text-slate-300">连续创作</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="rounded-2xl border p-5 shadow-sm" :style="{ backgroundColor: 'var(--surface)', borderColor: 'var(--border-clr)' }">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <h2 class="text-base font-semibold" :style="{ color: 'var(--text-primary)' }">本周写作趋势</h2>
                  <p class="text-xs mt-1" :style="{ color: 'var(--text-muted)' }">今日新增 {{ formatWordCount(todayWords) }} 字</p>
                </div>
                <div class="rounded-lg px-3 py-1 text-xs bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  {{ streakDays }} 天连续
                </div>
              </div>
              <div class="mt-6 h-40 flex items-end gap-2">
                <div v-for="day in chartDays" :key="day.date" class="flex-1 flex flex-col items-center gap-2">
                  <div class="w-full rounded-t-lg bg-gradient-to-t from-brand to-cyan-400 min-h-[8px]"
                    :style="{ height: `${Math.max(8, ((day.wordCount || 0) / maxChartWords) * 130)}px` }"></div>
                  <div class="text-[11px]" :style="{ color: 'var(--text-muted)' }">{{ formatDateLabel(day.date) }}</div>
                </div>
              </div>
            </div>
          </section>

          <!-- Workspace tools and preview -->
          <section class="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <h2 class="text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">常用工具</h2>
                  <p class="text-sm mt-1" :style="{ color: 'var(--text-muted)' }">围绕日常写作流程整理的快捷能力。</p>
                </div>
              </div>

              <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div v-for="item in quickTools" :key="item.title"
                  class="rounded-2xl border p-4 shadow-sm hover:-translate-y-0.5 hover:shadow-md transition-all"
                  :style="{ backgroundColor: 'var(--surface)', borderColor: 'var(--border-clr)' }">
                  <div :class="`h-10 w-10 rounded-xl bg-gradient-to-br ${item.accent} flex items-center justify-center text-xs font-semibold text-white`">
                    {{ item.metric }}
                  </div>
                  <h3 class="mt-4 text-base font-semibold" :style="{ color: 'var(--text-primary)' }">{{ item.title }}</h3>
                  <p class="mt-2 text-sm leading-6" :style="{ color: 'var(--text-secondary)' }">{{ item.desc }}</p>
                </div>
              </div>

              <div class="rounded-2xl border p-5 shadow-sm" :style="{ backgroundColor: 'var(--surface)', borderColor: 'var(--border-clr)' }">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <h2 class="text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">最近作品</h2>
                    <p class="text-sm mt-1" :style="{ color: 'var(--text-muted)' }">选择一个作品进入写作工作台。</p>
                  </div>
                  <button @click="showNewBookModal = true" class="btn-secondary text-xs px-3 py-1.5">新建</button>
                </div>

                <div v-if="recentBooks.length" class="mt-4 grid gap-3 md:grid-cols-2">
                  <div v-for="book in recentBooks" :key="book.id" @click="openBook(book)"
                    class="group cursor-pointer rounded-xl border p-4 transition-colors hover:border-brand"
                    :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="font-medium truncate" :style="{ color: 'var(--text-primary)' }">{{ book.title }}</div>
                        <div class="mt-2 flex flex-wrap gap-2 text-xs" :style="{ color: 'var(--text-muted)' }">
                          <span>{{ formatWordCount(book.word_count) }} 字</span>
                          <span>{{ getStatusLabel(book.status) }}</span>
                        </div>
                      </div>
                      <button @click="deleteBook(book, $event)"
                        class="shrink-0 h-7 w-7 rounded-lg text-xs opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40">
                        ×
                      </button>
                    </div>
                    <p class="mt-3 line-clamp-2 text-sm leading-6" :style="{ color: 'var(--text-secondary)' }">
                      {{ book.description || '暂无简介，进入编辑器继续完善作品设定。' }}
                    </p>
                  </div>
                </div>

                <div v-else class="mt-4 rounded-xl border border-dashed p-8 text-center" :style="{ borderColor: 'var(--border-clr)' }">
                  <h3 class="font-medium" :style="{ color: 'var(--text-primary)' }">还没有作品</h3>
                  <p class="mt-2 text-sm" :style="{ color: 'var(--text-muted)' }">创建第一部作品，开始管理章节、角色和创作进度。</p>
                  <div class="mt-4 flex flex-wrap justify-center gap-2">
                    <button @click="seedDemoBook" :disabled="isSeedingDemo" class="btn-primary disabled:opacity-60">
                      {{ isSeedingDemo ? '初始化中...' : '初始化示例作品' }}
                    </button>
                    <button @click="showNewBookModal = true" class="btn-secondary">创建空白作品</button>
                  </div>
                  <p v-if="seedError" class="mt-3 text-sm text-red-500">{{ seedError }}</p>
                </div>
              </div>
            </div>

            <aside class="space-y-4">
              <div class="rounded-2xl overflow-hidden bg-[#0b1020] text-white border border-white/10 shadow-sm">
                <div class="p-5 border-b border-white/10">
                  <div class="text-xs uppercase tracking-[0.18em] text-cyan-300">Story Map</div>
                  <h2 class="mt-2 text-lg font-semibold">人物关系概览</h2>
                  <p class="mt-2 text-sm leading-6 text-slate-300">把角色、阵营和关系沉淀下来，方便写长篇时回看设定。</p>
                </div>
                <div class="relative h-72 overflow-hidden">
                  <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(34,211,238,0.2),transparent_34%)]"></div>
                  <svg viewBox="0 0 320 240" class="relative h-full w-full">
                    <line x1="160" y1="116" x2="82" y2="68" stroke="#10b981" stroke-width="3" opacity="0.8" />
                    <line x1="160" y1="116" x2="250" y2="82" stroke="#ef4444" stroke-width="3" opacity="0.8" />
                    <line x1="160" y1="116" x2="96" y2="182" stroke="#3b82f6" stroke-width="2" opacity="0.8" />
                    <line x1="160" y1="116" x2="236" y2="178" stroke="#a855f7" stroke-width="2" stroke-dasharray="7 7" opacity="0.8" />
                    <circle cx="160" cy="116" r="30" fill="#2563eb" stroke="white" stroke-width="2" />
                    <circle cx="82" cy="68" r="24" fill="#059669" stroke="white" stroke-width="2" />
                    <circle cx="250" cy="82" r="24" fill="#dc2626" stroke="white" stroke-width="2" />
                    <circle cx="96" cy="182" r="22" fill="#7c3aed" stroke="white" stroke-width="2" />
                    <circle cx="236" cy="178" r="22" fill="#f59e0b" stroke="white" stroke-width="2" />
                    <text x="160" y="122" text-anchor="middle" class="fill-white text-xs font-semibold">主角</text>
                    <text x="82" y="72" text-anchor="middle" class="fill-white text-xs font-semibold">同伴</text>
                    <text x="250" y="86" text-anchor="middle" class="fill-white text-xs font-semibold">反派</text>
                    <text x="96" y="186" text-anchor="middle" class="fill-white text-xs font-semibold">导师</text>
                    <text x="236" y="182" text-anchor="middle" class="fill-white text-xs font-semibold">伏笔</text>
                  </svg>
                </div>
              </div>

              <div class="rounded-2xl border p-5 shadow-sm" :style="{ backgroundColor: 'var(--surface)', borderColor: 'var(--border-clr)' }">
                <h2 class="text-base font-semibold" :style="{ color: 'var(--text-primary)' }">今日写作建议</h2>
                <div class="mt-4 space-y-3">
                  <div class="flex gap-3">
                    <span class="mt-0.5 h-6 w-6 rounded-full bg-brand text-white text-xs flex items-center justify-center">1</span>
                    <p class="text-sm leading-6" :style="{ color: 'var(--text-secondary)' }">先打开最近作品，补完当前章节的关键情节。</p>
                  </div>
                  <div class="flex gap-3">
                    <span class="mt-0.5 h-6 w-6 rounded-full bg-brand text-white text-xs flex items-center justify-center">2</span>
                    <p class="text-sm leading-6" :style="{ color: 'var(--text-secondary)' }">写完后用润色和校对检查语言问题。</p>
                  </div>
                  <div class="flex gap-3">
                    <span class="mt-0.5 h-6 w-6 rounded-full bg-brand text-white text-xs flex items-center justify-center">3</span>
                    <p class="text-sm leading-6" :style="{ color: 'var(--text-secondary)' }">新增角色后同步整理人物关系，保持设定一致。</p>
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
