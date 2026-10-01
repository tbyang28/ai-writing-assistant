<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCommunityStore, communityError, type Page, type PublicProfile } from '@/stores/community'
import PublicBookCard from '@/components/PublicBookCard.vue'
import { apiGet } from '@/api'
import { useAuthStore } from '@/stores/auth'
const store = useCommunityStore(), route = useRoute(), router = useRouter()
const sort = ref<'latest' | 'popular'>('latest'), genre = ref(''), tag = ref(''), q = ref('')
const failure = ref(''), searchType = ref<'books' | 'users'>('books'), userLoading = ref(false)
const authors = ref<Page<PublicProfile>>({ items: [], page: 1, page_size: 12, total: 0, has_more: false })
const auth = useAuthStore()
let request = 0
async function load() {
  const seq = ++request
  searchType.value = route.query.type === 'users' ? 'users' : 'books'
  sort.value = route.query.sort === 'popular' ? 'popular' : 'latest'
  genre.value = String(route.query.genre || ''); tag.value = String(route.query.tag || ''); q.value = String(route.query.q || '')
  failure.value = ''
  if (searchType.value === 'users') {
    authors.value = { items: [], page: 1, page_size: 12, total: 0, has_more: false }; userLoading.value = true
    try { if (q.value.trim()) { const params = new URLSearchParams({ type: 'users', q: q.value.trim(), page: String(Math.max(1, Number(route.query.page) || 1)) }); const data = await apiGet<Page<PublicProfile>>(`/community/search?${params}`); if (seq === request) authors.value = data } } catch(e) { if (seq === request) failure.value = communityError(e) } finally { if (seq === request) userLoading.value = false }
    return
  }
  try { await store.fetchFeed({ sort: sort.value, genre: genre.value, tag: tag.value, q: q.value, page: Math.max(1, Number(route.query.page) || 1) }) } catch { failure.value = store.error }
}
function search(page = 1) { router.push({ path: '/discover', query: { type: searchType.value, sort: sort.value, ...(genre.value.trim() ? { genre: genre.value.trim() } : {}), ...(tag.value.trim() ? { tag: tag.value.trim() } : {}), ...(q.value.trim() ? { q: q.value.trim() } : {}), page } }) }
watch(() => [route.fullPath, auth.user?.id], load, { immediate: true })
</script>
<template>
  <div class="community-page"><div class="community-container">
    <header class="mb-7"><div class="eyebrow">Discover stories</div><h1 class="community-title mt-3">发现好故事</h1><p class="community-muted mt-2">从一段文字出发，走进另一个世界。阅读作者主动公开的作品。</p></header>
    <form class="card p-4 grid gap-4 md:grid-cols-2 xl:grid-cols-[110px_1fr_120px_120px_120px_auto] mb-6" @submit.prevent="search()">
      <label><span class="form-label">查找</span><select v-model="searchType" class="form-input"><option value="books">作品</option><option value="users">作者</option></select></label>
      <label class="block"><span class="form-label">{{ searchType === 'users' ? '搜索作者' : '搜索作品' }}</span><input v-model="q" class="form-input" :placeholder="searchType === 'users' ? '昵称或用户名' : '标题或简介'" maxlength="100" /></label>
      <label><span class="form-label">排序</span><select v-model="sort" :disabled="searchType === 'users'" class="form-input"><option value="latest">最新发布</option><option value="popular">热门作品</option></select></label>
      <label><span class="form-label">分类</span><input v-model="genre" :disabled="searchType === 'users'" class="form-input" list="genres" placeholder="全部分类" /><datalist id="genres"><option v-for="item in ['玄幻','都市','科幻','悬疑','言情','历史','奇幻']" :key="item" :value="item" /></datalist></label>
      <label><span class="form-label">标签</span><input v-model="tag" :disabled="searchType === 'users'" class="form-input" placeholder="全部标签" /></label>
      <button class="btn-primary self-end">查找</button>
    </form>
    <p v-if="failure" role="alert" class="community-feedback mb-4">{{ failure }} <button @click="load" class="underline">重试</button></p>
    <template v-if="searchType === 'users'">
      <p v-if="userLoading" class="community-muted py-12 text-center" role="status">寻找作者中…</p>
      <div v-else-if="authors.items.length" class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4"><router-link v-for="author in authors.items" :key="author.id" :to="`/community/users/${author.id}`" class="card p-5 flex gap-4 hover:border-brand"><img v-if="author.avatar" :src="author.avatar" alt="" class="w-12 h-12 rounded-full object-cover" loading="lazy" /><div v-else class="w-12 h-12 rounded-full flex shrink-0 items-center justify-center" :style="{ background: 'var(--brand-softer)' }">{{ (author.name || author.username).slice(0, 1) }}</div><div class="min-w-0"><h2 class="font-semibold truncate">{{ author.name || author.username }}</h2><p class="text-sm community-muted">@{{ author.username }}</p><p class="text-sm community-muted line-clamp-2 mt-2">{{ author.bio || '作者还没有填写简介。' }}</p><p class="text-xs community-muted mt-2">{{ author.book_count }} 部作品 · {{ author.follower_count }} 位关注者</p></div></router-link></div>
      <p v-else-if="!failure" class="card p-10 text-center community-muted">{{ q.trim() ? '没有找到这位作者，试试昵称或用户名。' : '输入昵称或用户名，寻找你喜欢的作者。' }}</p>
      <nav v-if="authors.total" aria-label="作者分页" class="flex justify-between items-center mt-6"><button class="btn-secondary" :disabled="authors.page <= 1" @click="search(authors.page - 1)">上一页</button><span class="community-muted text-sm">第 {{ authors.page }} 页 · 共 {{ authors.total }} 位</span><button class="btn-secondary" :disabled="!authors.has_more" @click="search(authors.page + 1)">下一页</button></nav>
    </template>
    <p v-else-if="store.loading.feed" class="community-muted py-12 text-center" role="status">正在寻找故事…</p>
    <template v-else><div v-if="store.feed.items.length" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4"><PublicBookCard v-for="book in store.feed.items" :key="book.id" :book="book" /></div>
      <div v-else-if="!failure" class="card p-12 text-center"><h2 class="font-serif text-2xl">这里还没有故事</h2><p class="community-muted mt-2">试试其他筛选条件，或发布你的第一部作品。</p><router-link to="/books" class="btn-secondary mt-5">去创作</router-link></div>
      <nav v-if="store.feed.total" aria-label="作品分页" class="flex justify-between items-center gap-3 mt-6"><button :disabled="store.feed.page <= 1" @click="search(store.feed.page - 1)" class="btn-secondary">上一页</button><span class="text-sm community-muted">第 {{ store.feed.page }} 页 · 共 {{ store.feed.total }} 部</span><button :disabled="!store.feed.has_more" @click="search(store.feed.page + 1)" class="btn-secondary">下一页</button></nav>
    </template>
  </div></div>
</template>
