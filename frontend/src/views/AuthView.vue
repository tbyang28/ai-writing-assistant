<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()

const isLogin = ref(true)
const email = ref('')
const password = ref('')
const name = ref('')
const isLoading = ref(false)
const errorMsg = ref('')

function toggleMode() {
  isLogin.value = !isLogin.value
  errorMsg.value = ''
}

async function handleSubmit() {
  if (!email.value || !password.value) return
  isLoading.value = true
  errorMsg.value = ''
  try {
    if (isLogin.value) {
      await authStore.login(email.value, password.value)
    } else {
      await authStore.register(email.value, password.value, name.value || undefined)
    }
    router.push('/')
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.detail || err?.message || '操作失败，请重试'
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="flex-1 flex items-center justify-center"
    :style="{ background: 'linear-gradient(135deg, var(--surface), var(--bg-page))' }">
    <div class="w-full max-w-sm mx-4">
      <!-- Header -->
      <div class="text-center mb-8">
        <h1 class="text-2xl font-bold" :style="{ color: 'var(--text-primary)' }">AI 写作助手</h1>
        <p class="text-sm mt-1" :style="{ color: 'var(--text-muted)' }">让创作更轻松</p>
      </div>

      <!-- Card -->
      <div class="rounded-2xl p-6 shadow-lg border"
        :style="{ backgroundColor: 'var(--surface)', borderColor: 'var(--border-clr)', color: 'var(--text-primary)' }">
        <h2 class="text-lg font-semibold mb-5">
          {{ isLogin ? '登录' : '注册' }}
        </h2>

        <form @submit.prevent="handleSubmit" class="space-y-4">
          <div v-if="!isLogin">
            <label class="form-label">昵称</label>
            <input v-model="name" type="text" class="form-input" placeholder="你的昵称（可选）" />
          </div>
          <div>
            <label class="form-label">邮箱</label>
            <input v-model="email" type="email" class="form-input" placeholder="请输入邮箱" required />
          </div>
          <div>
            <label class="form-label">密码</label>
            <input v-model="password" type="password" class="form-input" placeholder="请输入密码" required />
          </div>

          <div v-if="errorMsg" class="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">{{ errorMsg }}</div>

          <button type="submit" :disabled="isLoading || !email || !password" class="btn-primary w-full">
            {{ isLoading ? '处理中...' : (isLogin ? '登录' : '注册') }}
          </button>
        </form>

        <div class="mt-4 text-center text-sm" :style="{ color: 'var(--text-muted)' }">
          {{ isLogin ? '还没有账号？' : '已有账号？' }}
          <button @click="toggleMode" class="text-brand hover:text-brand-600 font-medium">
            {{ isLogin ? '去注册' : '去登录' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
