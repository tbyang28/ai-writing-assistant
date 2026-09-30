<script setup lang="ts">
import { ref } from 'vue'
import { useCommunityStore, communityError } from '@/stores/community'
import { useCommunityAccess } from '@/composables/useCommunityAccess'
const props = defineProps<{ targetType: 'BOOK' | 'COMMENT' | 'USER'; targetId: string }>()
const { requireLogin } = useCommunityAccess(), store = useCommunityStore()
const open = ref(false), reason = ref(''), busy = ref(false), message = ref('')
function begin() { if (requireLogin()) { open.value = true; message.value = '' } }
async function submit() { if (!reason.value.trim() || busy.value) return; busy.value = true; try { await store.report(props.targetType, props.targetId, reason.value.trim()); open.value = false; reason.value = ''; message.value = '举报已提交，感谢反馈。' } catch(e) { message.value = communityError(e) } finally { busy.value = false } }
</script>
<template>
  <span><button @click="begin" class="text-sm underline underline-offset-4 min-h-11 community-muted">举报</button><span v-if="message" class="text-xs ml-2" role="status">{{ message }}</span></span>
  <Teleport to="body"><div v-if="open" class="modal-overlay" @click.self="!busy && (open = false)" @keydown.esc="!busy && (open = false)"><form @submit.prevent="submit" class="modal-content" role="dialog" aria-modal="true" aria-labelledby="report-title"><h2 id="report-title" class="font-serif text-xl mb-4">举报内容</h2><label class="block"><span class="form-label">请说明原因</span><textarea v-model="reason" class="form-textarea" rows="4" maxlength="500" required autofocus /></label><p class="community-muted text-xs mt-2">最多 500 字。提交后由管理员处理。</p><p v-if="message" role="alert" class="community-feedback mt-3">{{ message }}</p><div class="flex justify-end gap-3 mt-5"><button type="button" @click="open = false" :disabled="busy" class="btn-secondary">取消</button><button :disabled="busy || !reason.trim()" class="btn-primary">{{ busy ? '提交中…' : '提交举报' }}</button></div></form></div></Teleport>
</template>
