<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { vReveal } from '@/composables/useReveal'
import { vSpotlight, vMagnetic, cursorFxEnabled } from '@/composables/useCursorFx'

const features = [
  {
    title: 'AI 续写',
    desc: '基于全书上下文自然延续情节，自动带入人物设定与前面章节的伏笔。',
  },
  {
    title: 'Diff 润色审阅',
    desc: '先逐字对比 AI 改了什么，再一键接受或拒绝。每一处修改都可追溯。',
  },
  {
    title: '文字校对',
    desc: '修正错别字、语法和标点问题，只输出干净正文，不夹带修改说明。',
  },
  {
    title: '故事记忆',
    desc: 'RAG 检索全书设定，续写前自动召回相关章节与人物，长篇不再写丢。',
  },
  {
    title: '人物关系图谱',
    desc: '沉淀角色、阵营与冲突关系，可随时打开图谱回看几十章前的设定。',
  },
  {
    title: '多模型切换',
    desc: 'DeepSeek、GLM、MiniMax 等五个模型随时切换，按任务选择最合适的。',
  },
]

const steps = [
  { num: '01', title: '沉淀设定', desc: '创建作品、章节与人物库，大纲和灵感统一收在一个工作台里。' },
  { num: '02', title: 'AI 辅助写作', desc: '续写、润色、校对都在编辑区侧栏完成，结果直接写回正文。' },
  { num: '03', title: '审阅与追踪', desc: 'AI 改动以 Diff 呈现，接受或拒绝由你决定，进度随时可见。' },
]

/* ---------- 光标驱动的效果 ---------- */
const scrollerRef = ref<HTMLElement | null>(null)
const heroRef = ref<HTMLElement | null>(null)
const mockRef = ref<HTMLElement | null>(null)
const decorRef = ref<HTMLElement | null>(null)
const dotRef = ref<HTMLElement | null>(null)
const haloRef = ref<HTMLElement | null>(null)
const progressRef = ref<HTMLElement | null>(null)

const fxOn = cursorFxEnabled()
let raf = 0
// 视差目标/当前值（-1..1 归一化，rAF 里做惯性插值）
const target = { x: 0, y: 0 }
const cur = { x: 0, y: 0 }
const mouse = { x: 0, y: 0 }
const dotCur = { x: 0, y: 0 }
const haloCur = { x: 0, y: 0 }
// 光标小点的状态机：静止淡出 / 悬停变环 / 按下收缩
let lastMoveTs = 0
let dotScale = 1
let dotOpacity = 0
let haloScale = 1
let isInteractiveHover = false
let isPressing = false

function onMove(e: MouseEvent) {
  mouse.x = e.clientX
  mouse.y = e.clientY
  lastMoveTs = performance.now()
  const hero = heroRef.value
  if (hero) {
    const r = hero.getBoundingClientRect()
    hero.style.setProperty('--gx', `${e.clientX - r.left}px`)
    hero.style.setProperty('--gy', `${e.clientY - r.top}px`)
    target.x = ((e.clientX - r.left) / r.width - 0.5) * 2
    target.y = ((e.clientY - r.top) / r.height - 0.5) * 2
  }
}

function onOver(e: MouseEvent) {
  const hit = (e.target as HTMLElement | null)?.closest?.('a, button, input, textarea, select, [data-cursor]')
  isInteractiveHover = !!hit
  dotRef.value?.classList.toggle('is-ring', isInteractiveHover)
}

function onScroll() {
  const scroller = scrollerRef.value
  const bar = progressRef.value
  if (!scroller || !bar) return
  const max = scroller.scrollHeight - scroller.clientHeight
  const ratio = max > 0 ? scroller.scrollTop / max : 0
  bar.style.transform = `scaleX(${ratio})`
}

function tick() {
  // 视差：模拟卡片顺光标、背景光斑逆光标
  cur.x += (target.x - cur.x) * 0.07
  cur.y += (target.y - cur.y) * 0.07
  if (mockRef.value) mockRef.value.style.transform = `translate3d(${cur.x * 10}px, ${cur.y * 8}px, 0)`
  if (decorRef.value) decorRef.value.style.transform = `translate3d(${cur.x * -18}px, ${cur.y * -14}px, 0)`
  // 光标跟随：小点快、光晕慢
  dotCur.x += (mouse.x - dotCur.x) * 0.4
  dotCur.y += (mouse.y - dotCur.y) * 0.4
  haloCur.x += (mouse.x - haloCur.x) * 0.11
  haloCur.y += (mouse.y - haloCur.y) * 0.11
  // 状态插值：静止 1.6s 后两者淡出消失；交互态小点放大成环、光晕收拢
  const idle = performance.now() - lastMoveTs > 1600
  const scaleTarget = isPressing ? 0.7 : isInteractiveHover ? 3 : 1
  const opacityTarget = idle ? 0 : 1
  const haloScaleTarget = isPressing ? 0.8 : isInteractiveHover ? 0.75 : 1
  dotScale += (scaleTarget - dotScale) * 0.18
  haloScale += (haloScaleTarget - haloScale) * 0.18
  dotOpacity += (opacityTarget - dotOpacity) * 0.12
  if (dotRef.value) {
    dotRef.value.style.transform = `translate3d(${dotCur.x - 4}px, ${dotCur.y - 4}px, 0) scale(${dotScale})`
    dotRef.value.style.opacity = String(dotOpacity)
  }
  if (haloRef.value) {
    haloRef.value.style.transform = `translate3d(${haloCur.x - 110}px, ${haloCur.y - 110}px, 0) scale(${haloScale})`
    haloRef.value.style.opacity = String(dotOpacity)
  }
  raf = requestAnimationFrame(tick)
}

const onPress = () => { isPressing = true }
const onRelease = () => { isPressing = false }

onMounted(() => {
  scrollerRef.value?.addEventListener('scroll', onScroll, { passive: true })
  if (!fxOn) return
  window.addEventListener('mousemove', onMove, { passive: true })
  window.addEventListener('mouseover', onOver, { passive: true })
  window.addEventListener('mousedown', onPress, { passive: true })
  window.addEventListener('mouseup', onRelease, { passive: true })
  raf = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  scrollerRef.value?.removeEventListener('scroll', onScroll)
  if (!fxOn) return
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseover', onOver)
  window.removeEventListener('mousedown', onPress)
  window.removeEventListener('mouseup', onRelease)
  cancelAnimationFrame(raf)
})
</script>

<template>
  <div ref="scrollerRef" class="h-full overflow-auto" :style="{ backgroundColor: 'var(--bg-page)', color: 'var(--text-primary)' }">
    <!-- 滚动进度条 -->
    <div ref="progressRef" class="fixed top-0 left-0 right-0 h-[2.5px] bg-brand z-50 origin-left"
      style="transform: scaleX(0)"></div>

    <!-- 光标跟随层（仅细指针 + 非 reduced-motion） -->
    <template v-if="fxOn">
      <div ref="haloRef" class="cursor-halo" style="transform: translate3d(-110px, -110px, 0)"></div>
      <div ref="dotRef" class="cursor-dot" style="transform: translate3d(-4px, -4px, 0)"></div>
    </template>
    <!-- 顶部导航 -->
    <nav class="sticky top-0 z-40 backdrop-blur-md border-b"
      :style="{ backgroundColor: 'color-mix(in srgb, var(--bg-page) 82%, transparent)', borderBottomColor: 'var(--border-clr)' }">
      <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="h-7 w-7 rounded-lg flex items-center justify-center bg-brand">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fffdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
            </svg>
          </div>
          <span class="font-serif font-semibold text-[15px]">AI 写作助手</span>
        </div>
        <div class="flex items-center gap-2">
          <RouterLink to="/auth" class="btn-ghost text-sm">登录</RouterLink>
          <RouterLink to="/auth" class="btn-primary text-sm">开始写作</RouterLink>
        </div>
      </div>
    </nav>

    <!-- Hero -->
    <section ref="heroRef" class="relative max-w-6xl mx-auto px-6 pt-16 pb-20 lg:pt-24">
      <div class="hero-glow absolute inset-0 pointer-events-none"></div>
      <div ref="decorRef" class="absolute top-0 right-0 h-96 w-96 rounded-full opacity-50 pointer-events-none will-change-transform"
        :style="{ background: 'radial-gradient(circle, var(--brand-soft) 0%, transparent 68%)' }"></div>

      <div class="relative grid lg:grid-cols-[1.05fr_0.95fr] gap-12 items-center">
        <div>
          <div class="animate-fade-up inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium"
            :style="{ borderColor: 'var(--border-clr)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }">
            <span class="h-1.5 w-1.5 rounded-full bg-brand inline-block"></span>
            为网文作者打造的长篇写作工作台
          </div>
          <h1 class="animate-fade-up stagger-1 mt-7 font-serif text-4xl md:text-5xl xl:text-[3.6rem] leading-[1.18] font-semibold">
            把长篇创作，<br />写成<span :style="{ color: 'var(--brand-hover)' }">可控的过程</span>。
          </h1>
          <p class="animate-fade-up stagger-2 mt-6 max-w-lg text-[15px] leading-8" :style="{ color: 'var(--text-secondary)' }">
            续写、润色、校对、人物图谱与故事记忆收在同一个界面里。
            AI 给出的是带完整上下文的建议，你保留最后一笔的决定权。
          </p>
          <div class="animate-fade-up stagger-3 mt-9 flex flex-wrap gap-3">
            <span v-magnetic="0.22" class="inline-block">
              <RouterLink to="/auth" class="btn-primary px-6 py-3 text-[15px]">
                免费开始写作
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12h14m-7-7 7 7-7 7"/>
                </svg>
              </RouterLink>
            </span>
            <span v-magnetic="0.16" class="inline-block">
              <RouterLink to="/auth" class="btn-secondary px-6 py-3 text-[15px]">已有账号，直接登录</RouterLink>
            </span>
          </div>
          <p class="animate-fade-up stagger-4 mt-4 text-xs" :style="{ color: 'var(--text-muted)' }">
            注册即可初始化示例作品，完整体验续写与 Diff 审阅流程。
          </p>
        </div>

        <!-- 模拟编辑器卡片：展示产品在做的事；外层视差、内层入场动画 -->
        <div ref="mockRef" class="relative will-change-transform">
          <div class="relative animate-pop-in stagger-2">
          <div class="motion-ambient animate-float absolute -top-4 -right-3 z-10 rounded-full px-3.5 py-1.5 text-xs font-medium border"
            :style="{ backgroundColor: 'var(--brand-soft)', color: 'var(--brand-hover)', borderColor: 'var(--border-clr)', boxShadow: 'var(--shadow-soft)', animationDelay: '0.8s' }">
            故事记忆：已召回 3 条设定
          </div>
          <div class="card p-0 overflow-hidden" :style="{ boxShadow: 'var(--shadow-lift)' }">
            <div class="flex items-center gap-2 px-4 py-3 border-b" :style="{ borderBottomColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }">
              <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: '#d98a75' }"></span>
              <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: '#dfc98f' }"></span>
              <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: '#a8c3a0' }"></span>
              <span class="ml-2 text-xs font-medium" :style="{ color: 'var(--text-muted)' }">第12章 · 雨夜重逢</span>
              <span class="ml-auto rounded-md px-2 py-0.5 text-[11px] font-medium chip-accent">AI 续写中</span>
            </div>
            <div class="p-5 space-y-3 font-serif">
              <div class="h-3.5 rounded" :style="{ backgroundColor: 'var(--surface-secondary)', width: '100%' }"></div>
              <div class="h-3.5 rounded" :style="{ backgroundColor: 'var(--surface-secondary)', width: '94%' }"></div>
              <div class="h-3.5 rounded" :style="{ backgroundColor: 'var(--surface-secondary)', width: '100%' }"></div>
              <p class="!m-0 py-1 text-[14px] leading-7" :style="{ color: 'var(--text-primary)' }">
                雨落在旧站台上，<del class="px-0.5 rounded decoration-[#a0432c]"
                  :style="{ backgroundColor: '#f3dcd5', color: '#a0432c' }">他等了很久</del><ins
                  class="px-0.5 rounded no-underline" :style="{ backgroundColor: '#dfe8dc', color: '#3e6b48' }">他等到伞沿滴出了一整条河</ins>。
              </p>
              <div class="h-3.5 rounded" :style="{ backgroundColor: 'var(--surface-secondary)', width: '72%' }"></div>
              <div class="flex items-center gap-1 h-3.5">
                <div class="h-3.5 rounded" :style="{ backgroundColor: 'var(--brand-soft)', width: '38%' }"></div>
                <span class="motion-ambient animate-caret inline-block w-[2px] h-4 bg-brand"></span>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 功能矩阵 -->
    <section class="border-t" :style="{ borderTopColor: 'var(--border-clr)', backgroundColor: 'var(--surface)' }">
      <div class="max-w-6xl mx-auto px-6 py-20">
        <div v-reveal class="max-w-2xl">
          <div class="eyebrow">Features</div>
          <h2 class="mt-3 font-serif text-3xl md:text-4xl font-semibold">为长篇写作而生</h2>
          <p class="mt-4 text-[15px] leading-7" :style="{ color: 'var(--text-secondary)' }">
            不是把聊天框塞进编辑器，而是围绕网文作者的完整流程设计——从设定沉淀到审阅写回。
          </p>
        </div>

        <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="(f, i) in features" :key="f.title"
            v-reveal="`${(i % 3) * 90}ms`"
            v-spotlight
            class="card p-5 hover-lift">
            <div class="font-serif text-base font-semibold" :style="{ color: 'var(--brand-hover)' }">
              {{ String(i + 1).padStart(2, '0') }}
            </div>
            <h3 class="mt-3 font-serif text-lg font-semibold">{{ f.title }}</h3>
            <p class="mt-2 text-[13.5px] leading-6" :style="{ color: 'var(--text-secondary)' }">{{ f.desc }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 三步工作流 -->
    <section class="border-t" :style="{ borderTopColor: 'var(--border-clr)' }">
      <div class="max-w-6xl mx-auto px-6 py-20">
        <div v-reveal class="max-w-2xl">
          <div class="eyebrow">Workflow</div>
          <h2 class="mt-3 font-serif text-3xl md:text-4xl font-semibold">三个动作，跑完全流程</h2>
        </div>
        <div class="mt-12 grid gap-5 md:grid-cols-3">
          <div v-for="(s, i) in steps" :key="s.num"
            v-reveal="`${i * 110}ms`"
            v-spotlight
            class="card p-6 relative overflow-hidden">
            <div class="h-10 w-10 rounded-full flex items-center justify-center font-serif text-sm font-semibold"
              :style="{ backgroundColor: 'var(--ink)', color: 'var(--ink-text)' }">{{ s.num }}</div>
            <h3 class="mt-4 font-serif text-lg font-semibold">{{ s.title }}</h3>
            <p class="mt-2 text-[13.5px] leading-6" :style="{ color: 'var(--text-secondary)' }">{{ s.desc }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 收尾 CTA -->
    <section class="border-t" :style="{ borderTopColor: 'var(--border-clr)', backgroundColor: 'var(--surface)' }">
      <div v-reveal class="max-w-6xl mx-auto px-6 py-24 text-center">
        <h2 class="font-serif text-3xl md:text-[2.6rem] leading-snug font-semibold">
          现在开始你的<span :style="{ color: 'var(--brand-hover)' }">下一章</span>。
        </h2>
        <p class="mt-4 text-[15px]" :style="{ color: 'var(--text-secondary)' }">
          注册即用，无需配置。示例作品一键初始化。
        </p>
        <span v-magnetic="0.25" class="inline-block mt-8">
          <RouterLink to="/auth" class="btn-primary px-7 py-3 text-[15px]">
            免费创建账号
          </RouterLink>
        </span>
      </div>
    </section>

    <!-- Footer -->
    <footer class="border-t" :style="{ borderTopColor: 'var(--border-clr)' }">
      <div class="max-w-6xl mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-xs"
        :style="{ color: 'var(--text-muted)' }">
        <span class="font-serif">AI 写作助手 · Writing Workspace</span>
        <span>NestJS · Vue3 · PostgreSQL pgvector · DeepSeek</span>
      </div>
    </footer>
  </div>
</template>
