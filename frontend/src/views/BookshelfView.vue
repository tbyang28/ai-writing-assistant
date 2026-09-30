<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { communityError, useCommunityStore, type Page, type PublicBook } from '@/stores/community'
import { useCommunityAccess } from '@/composables/useCommunityAccess'
import PublicBookCard from '@/components/PublicBookCard.vue'

const store = useCommunityStore(), route = useRoute(), router = useRouter()
const { auth, requireLogin } = useCommunityAccess()
const shelf = ref<Page<PublicBook> | null>(null), loading = ref(false), failure = ref(''), feedback = ref('')
const removing = ref('')
let request = 0
async function load() {
  const current = ++request
  shelf.value = null; failure.value = ''
  if (!auth.isLoggedIn) { loading.value = false; return }
  loading.value = true
  try { const data = await store.fetchFavorites(Math.max(1, Number(route.query.page) || 1)); if (current === request) shelf.value = data }
  catch (error) { if (current === request) failure.value = communityError(error) }
  finally { if (current === request) loading.value = false }
}
function changePage(page: number) { router.push({ path: '/bookshelf', query: { page } }) }
function readingLink(book: PublicBook) {
  const progress = book.reading_progress
  return progress ? { path: `/community/books/${book.id}/read/${progress.chapter_id}`, query: { position: progress.position } } : { path: `/community/books/${book.id}` }
}
async function remove(book: PublicBook) {
  if (!requireLogin() || removing.value) return
  removing.value = book.id; failure.value = ''; feedback.value = ''
  try {
    if (book.is_favorited) await store.toggleFavorite(book)
    feedback.value = `已将《${book.title}》移出书架。`
    if (shelf.value?.items.length === 1 && shelf.value.page > 1) changePage(shelf.value.page - 1)
    else await load()
  } catch (error) { failure.value = communityError(error) }
  finally { removing.value = '' }
}
watch(() => [route.query.page, auth.token], () => { feedback.value = ''; void load() }, { immediate: true })
</script>

<template>
  <div class="community-page"><div class="community-container">
    <header class="mb-7"><div class="eyebrow">Your reading shelf</div><h1 class="community-title mt-3">我的书架</h1><p class="community-muted mt-2">收藏喜欢的故事，让下一次阅读从上次停下的地方开始。</p></header>
    <div v-if="!auth.isLoggedIn" class="card p-10 text-center"><h2 class="font-serif text-2xl">登录后查看你的书架</h2><p class="community-muted mt-3">收藏和阅读进度会保存在你的账号中。</p><button class="btn-primary mt-5" @click="requireLogin">登录</button></div>
    <template v-else>
      <p v-if="failure" role="alert" class="community-feedback mb-4">{{ failure }} <button class="underline" @click="load">重试</button></p>
      <p v-if="feedback" role="status" class="community-feedback mb-4">{{ feedback }}</p>
      <p v-if="loading" role="status" class="community-muted py-12 text-center">正在整理书架…</p>
      <template v-else-if="shelf">
        <div v-if="shelf.items.length" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4"><PublicBookCard v-for="book in shelf.items" :key="book.id" :book="book"><div class="flex flex-wrap items-center gap-3 mt-4"><router-link :to="readingLink(book)" class="btn-primary text-sm">{{ book.reading_progress ? '继续阅读' : '开始阅读' }}</router-link><button class="text-sm community-muted underline min-h-11" :disabled="!!removing || store.pending[`favorite:${book.id}`]" @click="remove(book)">{{ removing === book.id ? '移除中…' : '移出书架' }}</button></div></PublicBookCard></div>
        <div v-else class="card p-12 text-center"><h2 class="font-serif text-2xl">书架正在等待一个好故事</h2><p class="community-muted mt-3">在作品详情页点击收藏，就能把故事放到这里。</p><router-link to="/discover" class="btn-primary mt-5">发现作品</router-link></div>
        <nav v-if="shelf.total" class="flex justify-between items-center gap-3 mt-6" aria-label="书架分页"><button class="btn-secondary" :disabled="shelf.page <= 1" @click="changePage(shelf.page - 1)">上一页</button><span class="community-muted text-sm">第 {{ shelf.page }} 页 · 共 {{ shelf.total }} 部</span><button class="btn-secondary" :disabled="!shelf.has_more" @click="changePage(shelf.page + 1)">下一页</button></nav>
      </template>
    </template>
  </div></div>
</template>
