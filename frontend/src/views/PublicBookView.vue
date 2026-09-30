<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useCommunityStore, communityError, type PublicBookDetail } from '@/stores/community'
import { useCommunityAccess } from '@/composables/useCommunityAccess'
import CommunityComments from '@/components/CommunityComments.vue'
import CommunityReport from '@/components/CommunityReport.vue'
const route = useRoute(), store = useCommunityStore(), { auth, requireLogin } = useCommunityAccess()
const detail = ref<PublicBookDetail | null>(null), loading = ref(false), failure = ref(''), feedback = ref('')
let sequence = 0
const firstChapter = computed(() => detail.value?.chapters[0])
const resumeChapter = computed(() => detail.value?.chapters.find(item => item.id === detail.value?.book.reading_progress?.chapter_id) || firstChapter.value)
async function load() { const seq = ++sequence; detail.value = null; loading.value = true; failure.value = ''; try { const data = await store.fetchPublicBook(String(route.params.id)); if (seq === sequence) detail.value = data } catch(e) { if (seq === sequence) failure.value = communityError(e) } finally { if (seq === sequence) loading.value = false } }
async function interact(kind: 'like' | 'favorite') { if (!requireLogin() || !detail.value) return; feedback.value = ''; try { if (kind === 'like') await store.toggleLike(detail.value.book); else await store.toggleFavorite(detail.value.book) } catch(e) { feedback.value = communityError(e) } }
watch(() => [route.params.id, auth.user?.id], load, { immediate: true })
</script>
<template>
  <div class="community-page"><div class="community-container max-w-4xl">
    <router-link to="/discover" class="text-sm community-muted hover:underline">← 发现作品</router-link>
    <p v-if="loading" role="status" class="py-16 text-center community-muted">正在展开故事…</p>
    <div v-else-if="failure" class="card p-8 mt-6"><h1 class="font-serif text-2xl">暂时无法打开作品</h1><p class="community-feedback mt-3" role="alert">{{ failure }}</p><button @click="load" class="btn-secondary mt-4">重试</button></div>
    <template v-else-if="detail">
      <header class="card p-6 md:p-8 mt-6"><div class="flex flex-col sm:flex-row gap-6">
        <div class="w-28 h-40 shrink-0 rounded-xl overflow-hidden flex items-center justify-center text-center font-serif text-xl p-3" :style="{ background: 'var(--brand-softer)' }"><img v-if="detail.book.cover" :src="detail.book.cover" :alt="`${detail.book.title}封面`" class="w-full h-full object-cover" /><span v-else>{{ detail.book.title }}</span></div>
        <div class="min-w-0 flex-1"><div class="eyebrow">{{ detail.book.genre || '故事' }} · {{ detail.book.status === 'FINISHED' ? '已完结' : '连载中' }}</div><h1 class="community-title mt-3 break-words">{{ detail.book.title }}</h1><router-link :to="`/community/users/${detail.book.author.id}`" class="inline-flex items-center gap-2 mt-3 text-sm hover:underline"><img v-if="detail.book.author.avatar" :src="detail.book.author.avatar" alt="" class="w-7 h-7 rounded-full object-cover" />{{ detail.book.author.name || detail.book.author.username }} <span class="community-muted">@{{ detail.book.author.username }}</span></router-link><div class="flex flex-wrap gap-3 mt-4 text-sm community-muted"><span>{{ detail.book.word_count.toLocaleString() }} 字</span><span>{{ detail.chapters.length }} 章</span><span>{{ detail.book.read_count }} 次阅读</span><span>{{ detail.book.like_count }} 赞</span></div><div class="flex flex-wrap gap-2 mt-3"><router-link v-for="tag in detail.book.tags" :key="tag" :to="{ path: '/discover', query: { tag } }" class="text-xs px-2 py-1 rounded-full" :style="{ background: 'var(--surface-secondary)' }">#{{ tag }}</router-link></div></div>
      </div><p class="whitespace-pre-wrap break-words leading-8 mt-6 community-muted">{{ detail.book.description || '作者还没有填写作品简介。' }}</p><div class="flex flex-wrap gap-3 items-center mt-6"><router-link v-if="resumeChapter" :to="`/community/books/${detail.book.id}/read/${resumeChapter.id}`" class="btn-primary">{{ detail.book.reading_progress ? '继续阅读' : '开始阅读' }}</router-link><button @click="interact('like')" :disabled="store.pending[`like:${detail.book.id}`]" :aria-pressed="detail.book.is_liked" class="btn-secondary">{{ detail.book.is_liked ? '已点赞' : '点赞' }} · {{ detail.book.like_count }}</button><button @click="interact('favorite')" :disabled="store.pending[`favorite:${detail.book.id}`]" :aria-pressed="detail.book.is_favorited" class="btn-secondary">{{ detail.book.is_favorited ? '已收藏' : '加入书架' }}</button><router-link v-if="auth.user?.id === detail.book.author.id" :to="`/editor/${detail.book.id}`" class="btn-secondary">管理作品</router-link><CommunityReport target-type="BOOK" :target-id="detail.book.id" /></div><p v-if="feedback" role="alert" class="community-feedback mt-3">{{ feedback }}</p></header>
      <section class="mt-8"><h2 class="font-serif text-2xl font-semibold mb-4">章节目录</h2><div v-if="detail.chapters.length" class="card divide-y" :style="{ borderColor: 'var(--border-clr)' }"><router-link v-for="chapter in detail.chapters" :key="chapter.id" :to="`/community/books/${detail.book.id}/read/${chapter.id}`" class="flex justify-between gap-4 p-4 hover:bg-[var(--surface-hover)]"><span class="break-words">第 {{ chapter.order }} 章 {{ chapter.title }}</span><span class="text-sm whitespace-nowrap community-muted">{{ chapter.word_count }} 字</span></router-link></div><p v-else class="card p-8 community-muted">作者尚未发布章节，收藏作品等待新故事。</p></section>
      <CommunityComments kind="books" :target-id="detail.book.id" :owner-id="detail.book.author.id" :allow-comments="detail.book.allow_comments" />
    </template>
  </div></div>
</template>
