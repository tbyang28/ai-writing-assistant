<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useCommunityStore, communityError, type CommunityComment } from '@/stores/community'
import { useCommunityAccess } from '@/composables/useCommunityAccess'
import CommunityReport from './CommunityReport.vue'
const props = defineProps<{ kind: 'books' | 'chapters'; targetId: string; ownerId: string; allowComments: boolean }>()
const store = useCommunityStore(), { auth, requireLogin } = useCommunityAccess()
const comments = ref<CommunityComment[]>([]), content = ref(''), reply = ref<CommunityComment | null>(null), loading = ref(false), busy = ref(false), error = ref('')
let request = 0
const ordered = computed(() => {
  const result: { comment: CommunityComment; depth: number }[] = [], seen = new Set<string>()
  function append(comment: CommunityComment, depth: number) { if (seen.has(comment.id)) return; seen.add(comment.id); result.push({ comment, depth }); comments.value.filter(item => item.parent_id === comment.id).forEach(item => append(item, Math.min(depth + 1, 2))) }
  comments.value.filter(item => !item.parent_id || !comments.value.some(parent => parent.id === item.parent_id)).forEach(item => append(item, 0))
  return result
})
async function load() { const seq = ++request; comments.value = []; loading.value = true; error.value = ''; try { const data = await store.fetchComments(props.kind, props.targetId); if (seq === request) comments.value = data } catch(e) { if (seq === request) error.value = communityError(e) } finally { if (seq === request) loading.value = false } }
async function submit() { if (!requireLogin() || !content.value.trim() || busy.value) return; busy.value = true; error.value = ''; try { await store.createComment(props.kind, props.targetId, content.value, reply.value?.id); content.value = ''; reply.value = null; await load() } catch(e) { error.value = communityError(e) } finally { busy.value = false } }
async function moderate(comment: CommunityComment, pin = false) { if (busy.value) return; busy.value = true; error.value = ''; try { if (pin) await store.pinComment(comment); else { if (!confirm('删除这条评论？')) return; await store.deleteComment(comment.id) }; await load() } catch(e) { error.value = communityError(e) } finally { busy.value = false } }
function beginReply(comment: CommunityComment) { if (requireLogin()) reply.value = comment }
watch(() => [props.kind, props.targetId, auth.user?.id], () => { reply.value = null; content.value = ''; load() }, { immediate: true })
</script>
<template>
  <section class="mt-8 border-t pt-7" :style="{ borderColor: 'var(--border-clr)' }">
    <h2 class="font-serif text-2xl font-semibold mb-4">读者讨论</h2>
    <p v-if="error" role="alert" class="community-feedback mb-4">{{ error }} <button @click="load" class="underline">重新加载</button></p>
    <form v-if="allowComments && auth.isLoggedIn" @submit.prevent="submit" class="card p-4 mb-5">
      <div v-if="reply" class="text-sm mb-2">回复 {{ reply.author.name || reply.author.username }} <button type="button" @click="reply = null" class="underline ml-3">取消回复</button></div>
      <label><span class="form-label">{{ reply ? '你的回复' : '说说你的阅读感受' }}</span><textarea v-model="content" class="form-textarea" rows="3" maxlength="2000" required /></label><div class="flex justify-between items-center gap-3 mt-3"><span class="text-xs community-muted">{{ content.length }} / 2000 · 评论以纯文本展示</span><button :disabled="busy || !content.trim()" class="btn-primary">{{ busy ? '发送中…' : reply ? '发送回复' : '发表评论' }}</button></div>
    </form>
    <p v-else-if="allowComments" class="community-muted mb-5">登录后可以参与讨论。<button @click="requireLogin" class="underline ml-2 min-h-11">登录 / 注册</button></p><p v-else class="community-muted mb-5">作者已关闭新评论。</p>
    <p v-if="loading" role="status" class="community-muted">加载讨论中…</p><p v-else-if="!comments.length" class="community-muted py-6">还没有评论，来分享第一份阅读感受。</p>
    <div v-else class="space-y-3"><article v-for="{ comment, depth } in ordered" :key="comment.id" class="card p-4" :style="{ marginLeft: `${depth * 16}px` }">
      <div class="flex flex-wrap justify-between gap-2 text-sm"><router-link :to="`/community/users/${comment.author.id}`" class="font-semibold hover:underline">{{ comment.author.name || comment.author.username }}</router-link><span class="text-xs community-muted">{{ comment.is_pinned ? '作者置顶 · ' : '' }}{{ new Date(comment.created_at).toLocaleString('zh-CN') }}</span></div>
      <p class="whitespace-pre-wrap break-words leading-7 mt-2 text-sm">{{ comment.content }}</p><div class="flex flex-wrap gap-4 mt-2"><button v-if="allowComments && !comment.is_deleted" @click="beginReply(comment)" class="text-sm min-h-11 underline community-muted">回复</button><button v-if="auth.user?.id === ownerId || auth.user?.id === comment.author.id" @click="moderate(comment)" :disabled="busy" class="text-sm min-h-11 underline community-muted">删除</button><button v-if="auth.user?.id === ownerId" @click="moderate(comment, true)" :disabled="busy" class="text-sm min-h-11 underline community-muted">{{ comment.is_pinned ? '取消置顶' : '置顶' }}</button><CommunityReport target-type="COMMENT" :target-id="comment.id" /></div>
    </article></div>
  </section>
</template>
