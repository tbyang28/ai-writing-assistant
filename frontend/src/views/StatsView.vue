<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useBookStore } from '@/stores/book'
import { useCountUp } from '@/composables/useCountUp'
import { vSpotlight } from '@/composables/useCursorFx'

const bookStore = useBookStore()

// 每日目标存在本地（产品层偏好，不入库）
const dailyGoal = ref(Number(localStorage.getItem('dailyWordGoal')) || 2000)
const editingGoal = ref(false)
const goalDraft = ref(String(dailyGoal.value))

const stats = computed(() => bookStore.writingStats)
const todayWords = computed(() => stats.value?.today_word_count || 0)
const streakDays = computed(() => stats.value?.streak_days || 0)
const totalWords = computed(() => bookStore.stats?.totalWords || 0)
const totalChapters = computed(() => bookStore.stats?.totalChapters || 0)

const todayRatio = computed(() => Math.min(1, todayWords.value / Math.max(1, dailyGoal.value)))
const ringDash = computed(() => {
  const c = 2 * Math.PI * 52
  return `${c * todayRatio.value} ${c}`
})

const animToday = useCountUp(() => todayWords.value)
const animStreak = useCountUp(() => streakDays.value)
const animTotalWords = useCountUp(() => totalWords.value)
const animChapters = useCountUp(() => totalChapters.value)

// 12 周热力图：last_84_days[date] -> wordCount
// 注意：后端按 UTC 日分桶（updated_at AT TIME ZONE 'UTC'），这里必须同样用 UTC 生成格子，
// 否则 UTC+8 用户会错位一天、今天的数据落不进格子。
interface DayCell { date: string; words: number; level: 0 | 1 | 2 | 3 | 4 }
const heatWeeks = computed<DayCell[][]>(() => {
  const raw: { date: string; wordCount: number }[] = stats.value?.last_7_days || []
  const map = new Map(raw.map((d) => [d.date, d.wordCount || 0]))
  const maxWords = Math.max(...raw.map((d) => d.wordCount || 0), 1)

  // 锚点优先用后端返回的 UTC 今天（stats.today），拿不到再用本地 UTC 换算
  const utcKey = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  const anchor = (stats.value?.today as string) || utcKey(new Date())

  const days: DayCell[] = []
  const anchorDate = new Date(`${anchor}T00:00:00.000Z`)
  for (let i = 83; i >= 0; i--) {
    const d = new Date(anchorDate)
    d.setUTCDate(anchorDate.getUTCDate() - i)
    const key = utcKey(d)
    const words = map.get(key) || 0
    const r = words / maxWords
    const level: DayCell['level'] = words === 0 ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.75 ? 3 : 4
    days.push({ date: key, words, level })
  }

  // 从周一开列：用首格的星期把列补齐（date 是 UTC 日串，必须用 getUTCDay）
  const first = new Date(`${days[0].date}T00:00:00.000Z`)
  const pad = (first.getUTCDay() + 6) % 7 // 周一 = 0
  const padded: (DayCell | null)[] = [...Array(pad).fill(null), ...days]
  const weeks: DayCell[][] = []
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7).map((c) => c || { date: '', words: 0, level: 0 as const }))
  }
  return weeks
})

const levelColors = [
  'var(--surface-secondary)',
  '#f3d9ca', '#e8b69c', '#dd9071', 'var(--brand)',
]

onMounted(async () => {
  try {
    await Promise.all([bookStore.fetchWritingStats(84), bookStore.fetchStats()])
  } catch (err) {
    console.error('加载统计失败:', err)
  }
})

function saveGoal() {
  const n = Math.max(100, Math.floor(Number(goalDraft.value)) || dailyGoal.value)
  dailyGoal.value = n
  localStorage.setItem('dailyWordGoal', String(n))
  editingGoal.value = false
}

function formatWordCount(count: number) {
  if (!count) return '0'
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}
</script>

<template>
  <div class="flex-1 min-h-0 overflow-auto">
    <div class="min-h-full" :style="{ backgroundColor: 'var(--bg-page)' }">
      <div class="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header class="pt-4 pb-2 animate-fade-up">
          <div class="eyebrow flex items-center gap-2">
            <span class="h-1.5 w-1.5 rounded-full bg-brand inline-block"></span>
            Writing Stats
          </div>
          <h1 class="mt-4 font-serif text-4xl font-semibold leading-tight" :style="{ color: 'var(--text-primary)' }">写作统计</h1>
          <p class="mt-2 text-[15px]" :style="{ color: 'var(--text-secondary)' }">
            目标、连续天数与长期的码字节奏，可视化你的坚持。
          </p>
        </header>

        <!-- 今日目标 + 数据卡 -->
        <section class="grid gap-5 lg:grid-cols-[340px_1fr]">
          <div class="card p-6 animate-fade-up stagger-1 flex items-center gap-6">
            <div class="relative h-32 w-32 shrink-0">
              <svg viewBox="0 0 120 120" class="h-full w-full -rotate-90">
                <circle cx="60" cy="60" r="52" fill="none" stroke-width="10"
                  :stroke="'var(--surface-secondary)'" />
                <circle cx="60" cy="60" r="52" fill="none" stroke-width="10" stroke-linecap="round"
                  stroke="var(--brand)" :stroke-dasharray="ringDash"
                  class="transition-[stroke-dasharray] duration-700 ease-out" />
              </svg>
              <div class="absolute inset-0 flex flex-col items-center justify-center">
                <span class="font-serif text-2xl font-semibold" :style="{ color: 'var(--text-primary)' }">{{ animToday }}</span>
                <span class="text-[11px]" :style="{ color: 'var(--text-muted)' }">/ {{ dailyGoal }} 字</span>
              </div>
            </div>
            <div class="min-w-0">
              <div class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">今日目标</div>
              <p class="mt-1.5 text-xs leading-5" :style="{ color: 'var(--text-muted)' }">
                {{ todayRatio >= 1 ? '目标已达成，保持节奏。' : `还差 ${Math.max(0, dailyGoal - animToday)} 字，写一小段就够了。` }}
              </p>
              <div v-if="editingGoal" class="mt-3 flex items-center gap-2">
                <input v-model="goalDraft" type="number" min="100" class="form-input !w-24 !py-1.5 text-xs" @keyup.enter="saveGoal" />
                <button @click="saveGoal" class="btn-primary !px-2.5 !py-1.5 text-xs">保存</button>
              </div>
              <button v-else @click="editingGoal = true; goalDraft = String(dailyGoal)" class="btn-ghost mt-3 !px-2 text-xs" :style="{ color: 'var(--brand-hover)' }">
                调整目标
              </button>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-4">
            <div v-for="(card, i) in [
              { label: '连续创作', value: `${animStreak} 天` },
              { label: '累计字数', value: formatWordCount(animTotalWords) },
              { label: '章节沉淀', value: animChapters },
            ]" :key="card.label"
              v-spotlight
              class="card px-5 py-4 animate-fade-up flex flex-col justify-center"
              :class="`stagger-${i + 2}`">
              <div class="font-serif text-3xl font-semibold" :style="{ color: 'var(--text-primary)' }">{{ card.value }}</div>
              <div class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">{{ card.label }}</div>
            </div>
          </div>
        </section>

        <!-- 12 周热力图 -->
        <section class="card p-6 animate-fade-up stagger-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold" :style="{ color: 'var(--text-primary)' }">近 12 周码字热力</h2>
              <p class="text-xs mt-1" :style="{ color: 'var(--text-muted)' }">颜色越深，当天写得越多</p>
            </div>
            <div class="flex items-center gap-1.5 text-[11px]" :style="{ color: 'var(--text-muted)' }">
              少
              <span v-for="c in levelColors" :key="c" class="h-2.5 w-2.5 rounded-[3px]" :style="{ backgroundColor: c }"></span>
              多
            </div>
          </div>
          <div class="mt-5 overflow-x-auto pb-1">
            <div class="flex gap-1 min-w-max">
              <div v-for="(week, wi) in heatWeeks" :key="wi" class="flex flex-col gap-1">
                <div v-for="(day, di) in week" :key="di"
                  class="h-3.5 w-3.5 rounded-[4px] motion-ambient animate-fade-in"
                  :style="{ backgroundColor: levelColors[day.level], animationDelay: `${(wi * 7 + di) * 6}ms` }"
                  :title="day.date ? `${day.date}：${day.words} 字` : ''">
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
