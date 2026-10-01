<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { communityError, useCommunityStore, type CommunityNotification } from '@/stores/community'
import { useCommunityAccess } from '@/composables/useCommunityAccess'

const route = useRoute(), router = useRouter(), store = useCommunityStore()
const { auth, requireLogin } = useCommunityAccess()
const items = ref<CommunityNotification[]>([]), loading = ref(false), marking = ref(false)
const failure = ref(''), feedback = ref(''), pageSize = 20
const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const unread = computed(() => items.value.filter(item => !item.read_at).length)
let request = 0
async function load() {
  const current = ++request
  items.value = []; failure.value = ''
  if (!auth.isLoggedIn) { loading.value = false; return }
  loading.value = true
  try { const data = await store.fetchNotifications(page.value, pageSize); if (current === request) items.value = data }
  catch (error) { if (current === request) failure.value = communityError(error) }
  finally { if (current === request) loading.value = false }
}
async function markRead() {
  if (!requireLogin() || marking.value) return
  marking.value = true; failure.value = ''; feedback.value = ''
  try { await store.markNotificationsRead(); feedback.value = '所有通知已标为已读。' }
  catch (error) { failure.value = communityError(error) }
  finally { marking.value = false }
}
function description(item: CommunityNotification) {
  const messages: Record<string, string> = { FOLLOW: '关注了你', LIKE: '赞了你的作品', COMMENT: '评论了你的作品', REPLY: '回复了你的评论' }
  return messages[item.type.toUpperCase()] || '与你有新的互动'
}
function destination(item: CommunityNotification) {
  if (item.book_id && item.chapter_id) return `/community/books/${item.book_id}/read/${item.chapter_id}`
  if (item.book_id) return `/community/books/${item.book_id}`
  return item.actor ? `/community/users/${item.actor.id}` : null
}
function date(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function changePage(value: number) { router.push({ path: '/notifications', query: { page: value } }) }
watch(() => [route.query.page, auth.token], () => { feedback.value = ''; void load() }, { immediate: true })
</script>

<template>
  <div class="community-page"><div class="community-container max-w-3xl">
    <header class="flex flex-wrap items-end justify-between gap-4 mb-7"><div><div class="eyebrow">Letters from your readers</div><h1 class="community-title mt-3">通知</h1><p class="community-muted mt-2">读者的关注、点赞与讨论，都在这里与你相遇。</p></div><button v-if="auth.isLoggedIn" class="btn-secondary" :disabled="marking || loading" @click="markRead">{{ marking ? '处理中…' : '全部标为已读' }}</button></header>
    <div v-if="!auth.isLoggedIn" class="card p-10 text-center"><h2 class="font-serif text-2xl">登录后查看通知</h2><p class="community-muted mt-3">看看谁关注了你，或在你的作品下留下了评论。</p><button class="btn-primary mt-5" @click="requireLogin">登录</button></div>
    <template v-else>
      <p v-if="failure" role="alert" class="community-feedback mb-4">{{ failure }} <button class="underline" @click="load">重试</button></p>
      <p v-if="feedback" role="status" class="community-feedback mb-4">{{ feedback }}</p>
      <p v-if="loading" role="status" class="community-muted py-12 text-center">正在读取通知…</p>
      <template v-else>
        <p v-if="items.length" class="community-muted text-sm mb-3">本页 {{ unread }} 条未读</p>
        <ul v-if="items.length" class="space-y-3"><li v-for="item in items" :key="item.id" class="card p-5 flex items-start gap-4">
          <router-link v-if="item.actor" :to="`/community/users/${item.actor.id}`" :aria-label="`查看${item.actor.name || item.actor.username}的资料`" class="shrink-0"><img v-if="item.actor.avatar" :src="item.actor.avatar" alt="" class="w-11 h-11 rounded-full object-cover" /><span v-else class="w-11 h-11 rounded-full flex items-center justify-center font-serif" :style="{ background: 'var(--brand-softer)' }">{{ (item.actor.name || item.actor.username).slice(0, 1) }}</span></router-link>
          <div class="min-w-0 flex-1"><p class="leading-6 break-words"><router-link v-if="item.actor" :to="`/community/users/${item.actor.id}`" class="font-semibold hover:underline">{{ item.actor.name || item.actor.username }}</router-link><span v-else class="font-semibold">一位读者</span> {{ description(item) }}</p><div class="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm"><time :datetime="item.created_at" class="community-muted">{{ date(item.created_at) }}</time><router-link v-if="destination(item)" :to="destination(item)!" class="underline underline-offset-4">查看{{ item.type.toUpperCase() === 'FOLLOW' ? '作者' : '详情' }}</router-link></div></div>
          <span class="shrink-0 text-xs community-muted mt-1">{{ item.read_at ? '已读' : '未读' }}</span>
        </li></ul>
        <div v-else-if="!failure" class="card p-12 text-center"><h2 class="font-serif text-2xl">{{ page > 1 ? '这一页没有更多通知了' : '暂时还没有新消息' }}</h2><p class="community-muted mt-3">公开作品后，读者的互动会出现在这里。</p><router-link to="/discover" class="btn-secondary mt-5">去发现故事</router-link></div>
        <nav v-if="items.length || page > 1" class="flex justify-between items-center gap-3 mt-6" aria-label="通知分页"><button class="btn-secondary" :disabled="page <= 1" @click="changePage(page - 1)">上一页</button><span class="community-muted text-sm">第 {{ page }} 页</span><button class="btn-secondary" :disabled="items.length < pageSize" @click="changePage(page + 1)">下一页</button></nav>
      </template>
    </template>
  </div></div>
</template>
