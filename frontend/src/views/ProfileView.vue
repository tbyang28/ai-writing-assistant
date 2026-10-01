<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { communityError, useCommunityStore, type PublicBook, type PublicProfile } from '@/stores/community'
import { useCommunityAccess } from '@/composables/useCommunityAccess'
import PublicBookCard from '@/components/PublicBookCard.vue'
import CommunityReport from '@/components/CommunityReport.vue'

const route = useRoute(), store = useCommunityStore()
const { auth, requireLogin } = useCommunityAccess()
const profile = ref<PublicProfile | null>(null), books = ref<PublicBook[]>([])
const loading = ref(false), busy = ref(false), saving = ref(false), failure = ref(''), feedback = ref('')
const username = ref(''), bio = ref(''), avatar = ref('')
const ownProfile = computed(() => auth.isLoggedIn && auth.user?.id === profile.value?.id)
let request = 0
async function load() {
  const current = ++request, id = String(route.params.id)
  loading.value = true; failure.value = ''; profile.value = null; books.value = []
  try {
    const data = await store.fetchProfile(id)
    if (current !== request) return
    profile.value = data.profile; books.value = data.books
    username.value = data.profile.username; bio.value = data.profile.bio || ''; avatar.value = data.profile.avatar || ''
  } catch (error) { if (current === request) failure.value = communityError(error) }
  finally { if (current === request) loading.value = false }
}
async function save() {
  if (!ownProfile.value || saving.value) return
  const id = profile.value!.id
  saving.value = true; failure.value = ''; feedback.value = ''
  try {
    await store.updateProfile({ username: username.value.trim(), bio: bio.value.trim(), avatar: avatar.value.trim() })
    await auth.fetchProfile()
    if (String(route.params.id) === id) { await load(); feedback.value = '公开资料已保存。' }
  } catch (error) { failure.value = communityError(error) }
  finally { saving.value = false }
}
async function interact(kind: 'follow' | 'block') {
  if (!requireLogin() || !profile.value || busy.value) return
  busy.value = true; failure.value = ''; feedback.value = ''
  const author = profile.value
  try {
    if (kind === 'follow') await store.toggleFollow(author)
    else {
      await store.toggleBlock(author)
      feedback.value = author.is_blocked ? '已拉黑，相关作品和互动将被隐藏。' : '已解除拉黑。'
      await load()
      await store.fetchFeed()
    }
  } catch (error) { failure.value = communityError(error) }
  finally { busy.value = false }
}
watch(() => [route.params.id, auth.user?.id], () => { feedback.value = ''; void load() }, { immediate: true })
</script>

<template>
  <div class="community-page"><div class="community-container">
    <p v-if="failure" role="alert" class="community-feedback mb-5">{{ failure }} <button class="underline" @click="load">重新加载</button></p>
    <p v-if="feedback" role="status" class="community-feedback mb-5">{{ feedback }}</p>
    <p v-if="loading" role="status" class="community-muted py-12 text-center">正在读取作者资料…</p>
    <template v-else-if="profile">
      <header class="card p-6 sm:p-8 mb-7">
        <div class="flex flex-col sm:flex-row gap-5 items-start">
          <img v-if="profile.avatar" :src="profile.avatar" :alt="`${profile.username}的头像`" class="w-20 h-20 rounded-full object-cover shrink-0" />
          <div v-else class="w-20 h-20 rounded-full flex items-center justify-center font-serif text-3xl shrink-0" :style="{ background: 'var(--brand-softer)' }" aria-hidden="true">{{ (profile.name || profile.username).slice(0, 1) }}</div>
          <div class="flex-1 min-w-0"><div class="eyebrow">Author's corner</div><h1 class="community-title mt-2 break-words">{{ profile.name || profile.username }}</h1><p class="community-muted mt-1 break-all">@{{ profile.username }}</p><p class="mt-4 leading-7 whitespace-pre-wrap break-words">{{ profile.bio || '作者还没有填写简介。' }}</p>
            <div class="flex flex-wrap gap-5 community-muted text-sm mt-4"><span>{{ profile.book_count }} 部公开作品</span><span>{{ profile.follower_count }} 位关注者</span><span>关注 {{ profile.following_count }} 人</span></div>
          </div>
        </div>
        <div v-if="!ownProfile" class="flex flex-wrap items-center gap-3 mt-6">
          <button v-if="!profile.is_blocked" class="btn-primary" :disabled="busy" @click="interact('follow')">{{ busy ? '处理中…' : profile.is_following ? '取消关注' : '关注作者' }}</button>
          <button class="btn-secondary" :disabled="busy" @click="interact('block')">{{ profile.is_blocked ? '解除拉黑' : '拉黑作者' }}</button>
          <CommunityReport :key="profile.id" target-type="USER" :target-id="profile.id" />
        </div>
      </header>
      <form v-if="ownProfile" class="card p-6 mb-7" @submit.prevent="save">
        <h2 class="font-serif text-xl mb-5">编辑公开资料</h2>
        <div class="grid sm:grid-cols-2 gap-4"><label><span class="form-label">公开用户名</span><input v-model="username" class="form-input" minlength="3" maxlength="32" pattern="[a-zA-Z0-9_-]+" required :disabled="saving" /><span class="community-muted text-xs block mt-2">3–32 个英文字母、数字、下划线或短横线。</span></label><label><span class="form-label">头像地址</span><input v-model="avatar" class="form-input" type="url" placeholder="https://…" pattern="https?://.*" :disabled="saving" /><span class="community-muted text-xs block mt-2">填写 http/https 图片地址，留空可移除头像。</span></label></div>
        <label class="block mt-4"><span class="form-label">作者简介</span><textarea v-model="bio" class="form-textarea" rows="4" maxlength="300" :disabled="saving" /><span class="community-muted text-xs block mt-1">{{ bio.length }}/300</span></label>
        <div class="flex justify-end mt-5"><button class="btn-primary" :disabled="saving">{{ saving ? '保存中…' : '保存公开资料' }}</button></div>
      </form>
      <section aria-labelledby="profile-books"><h2 id="profile-books" class="font-serif text-2xl mb-4">公开作品</h2><div v-if="books.length" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4"><PublicBookCard v-for="book in books" :key="book.id" :book="book" /></div><div v-else class="card p-10 text-center community-muted">{{ profile.is_blocked ? '已隐藏这位作者的作品。' : '这位作者还没有公开作品。' }}</div></section>
    </template>
    <router-link to="/discover" class="inline-block community-muted underline mt-7">返回发现页</router-link>
  </div></div>
</template>
