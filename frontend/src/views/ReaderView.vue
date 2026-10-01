<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useCommunityStore, communityError, type PublicBookDetail, type PublicChapter } from '@/stores/community'
import { useCommunityAccess } from '@/composables/useCommunityAccess'
import CommunityComments from '@/components/CommunityComments.vue'
const route = useRoute(), store = useCommunityStore(), { auth } = useCommunityAccess()
const detail = ref<PublicBookDetail | null>(null), chapter = ref<PublicChapter | null>(null), scrollArea = ref<HTMLElement | null>(null)
const loading = ref(false), failure = ref(''), progressError = ref(''), fontSize = ref(18)
let sequence = 0, ready = false, timer: ReturnType<typeof setTimeout> | null = null
const index = computed(() => detail.value?.chapters.findIndex(item => item.id === chapter.value?.id) ?? -1)
const previous = computed(() => index.value > 0 ? detail.value?.chapters[index.value - 1] : undefined)
const next = computed(() => index.value >= 0 ? detail.value?.chapters[index.value + 1] : undefined)
async function saveProgress() { if (!ready || !auth.isLoggedIn || !chapter.value || !detail.value) return; const bookId = detail.value.book.id, chapterId = chapter.value.id, position = Math.max(0, Math.round(scrollArea.value?.scrollTop || 0)); try { await store.saveProgress(bookId, chapterId, position); progressError.value = '' } catch(e) { progressError.value = communityError(e) } }
function scrolled() { if (!ready) return; if (timer) clearTimeout(timer); timer = setTimeout(saveProgress, 700) }
async function load() {
  if (timer) { clearTimeout(timer); timer = null }
  await saveProgress(); ready = false
  const seq = ++sequence; loading.value = true; failure.value = ''; detail.value = null; chapter.value = null
  try {
    const bookId = String(route.params.id), chapterId = String(route.params.chapterId)
    const [bookData, chapterData] = await Promise.all([store.fetchPublicBook(bookId), store.fetchChapter(chapterId)])
    if (seq !== sequence) return
    if (chapterData.book.id !== bookId || !bookData.chapters.some(item => item.id === chapterId)) throw new Error('章节不属于这部公开作品')
    detail.value = bookData; chapter.value = chapterData.chapter; loading.value = false
    await nextTick()
    if (scrollArea.value) scrollArea.value.scrollTop = bookData.book.reading_progress?.chapter_id === chapterId ? bookData.book.reading_progress.position : 0
    ready = true
    await saveProgress()
  } catch(e) { if (seq === sequence) failure.value = communityError(e) } finally { if (seq === sequence) loading.value = false }
}
watch(() => [route.params.id, route.params.chapterId, auth.user?.id], load, { immediate: true })
onBeforeUnmount(() => { if (timer) clearTimeout(timer); saveProgress(); sequence++ })
</script>
<template>
  <div ref="scrollArea" @scroll.passive="scrolled" class="community-page"><div class="community-container max-w-3xl">
    <router-link :to="`/community/books/${route.params.id}`" class="text-sm community-muted hover:underline">← 作品详情与目录</router-link>
    <p v-if="loading" class="text-center py-16 community-muted" role="status">正在加载章节…</p><div v-else-if="failure" class="card p-8 mt-6"><h1 class="font-serif text-2xl">暂时无法阅读</h1><p role="alert" class="community-feedback mt-3">{{ failure }}</p><button @click="load" class="btn-secondary mt-4">重试</button></div>
    <template v-else-if="detail && chapter"><header class="mt-7 pb-6 border-b" :style="{ borderColor: 'var(--border-clr)' }"><div class="eyebrow">{{ detail.book.title }}</div><h1 class="font-serif text-3xl leading-snug font-semibold mt-3">第 {{ chapter.order }} 章 {{ chapter.title }}</h1><div class="flex flex-wrap justify-between items-center gap-3 mt-4"><span class="text-sm community-muted">{{ chapter.word_count }} 字 · {{ auth.isLoggedIn ? '自动记录阅读进度' : '登录后可保存阅读进度' }}</span><label class="flex gap-2 items-center text-sm community-muted">字号<select v-model.number="fontSize" class="form-input !w-auto"><option :value="16">小</option><option :value="18">标准</option><option :value="22">大</option></select></label></div><p v-if="progressError" class="community-feedback text-xs mt-2" role="status">进度未保存：{{ progressError }}</p></header>
      <article class="whitespace-pre-wrap break-words py-8 font-serif" :style="{ fontSize: `${fontSize}px`, lineHeight: 2.1 }">{{ chapter.content || '本章暂无正文。' }}</article>
      <nav class="flex flex-wrap justify-between gap-3 border-t pt-6" aria-label="章节导航" :style="{ borderColor: 'var(--border-clr)' }"><router-link v-if="previous" :to="`/community/books/${detail.book.id}/read/${previous.id}`" class="btn-secondary">← 上一章</router-link><span v-else class="community-muted self-center text-sm">已是第一章</span><router-link :to="`/community/books/${detail.book.id}`" class="btn-secondary">目录</router-link><router-link v-if="next" :to="`/community/books/${detail.book.id}/read/${next.id}`" class="btn-primary">下一章 →</router-link><span v-else class="community-muted self-center text-sm">已读至最新章</span></nav>
      <CommunityComments kind="chapters" :target-id="chapter.id" :owner-id="detail.book.author.id" :allow-comments="detail.book.allow_comments" />
    </template>
  </div></div>
</template>
