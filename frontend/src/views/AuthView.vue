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
    router.push('/home')
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.detail || err?.message || '操作失败，请重试'
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="flex-1 min-h-0 overflow-auto" :style="{ backgroundColor: 'var(--bg-page)' }">
    <div class="min-h-full grid lg:grid-cols-[1.08fr_0.92fr]">
      <!-- 编辑感左栏：暖纸面 + 衬线大字 + 橙点装饰 -->
      <section class="relative hidden lg:flex flex-col justify-between overflow-hidden px-12 py-12 xl:px-16 border-r"
        :style="{ borderRightColor: 'var(--border-clr)' }">
        <div class="absolute -top-24 -right-24 h-72 w-72 rounded-full opacity-60"
          :style="{ background: 'radial-gradient(circle, var(--brand-soft) 0%, transparent 70%)' }"></div>

        <div class="relative animate-fade-up">
          <div class="eyebrow flex items-center gap-2">
            <span class="h-1.5 w-1.5 rounded-full bg-brand inline-block"></span>
            AI Writing Assistant
          </div>
          <h1 class="mt-10 max-w-xl font-serif text-[3.4rem] leading-[1.15] font-semibold"
            :style="{ color: 'var(--text-primary)' }">
            把长篇创作，<br />写成<em class="not-italic" :style="{ color: 'var(--brand-hover)' }">可控的过程</em>。
          </h1>
          <p class="mt-7 max-w-md text-[15px] leading-8" :style="{ color: 'var(--text-secondary)' }">
            管理作品、章节、人物和关系图谱；在需要时，用 AI 续写、润色、校对，并从全书中召回你写过的设定。
          </p>
        </div>

        <div class="relative space-y-5 max-w-lg">
          <div v-for="(item, i) in [
            { title: '上下文记忆', desc: '续写前自动检索相关章节与人物设定，减少长篇“写着写着忘了”。' },
            { title: 'Diff 润色审阅', desc: '先看 AI 改了什么，再决定是否写回正文。每一处修改都可追溯。' },
            { title: '人物关系图谱', desc: '沉淀角色、阵营与冲突，随时回看，保持几十章后的设定一致。' },
          ]" :key="item.title" class="flex gap-4 animate-fade-up" :class="`stagger-${i + 2}`">
            <div class="mt-1.5 h-2 w-2 shrink-0 rounded-sm rotate-45 bg-brand"></div>
            <div>
              <div class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">{{ item.title }}</div>
              <p class="mt-1 text-sm leading-6" :style="{ color: 'var(--text-secondary)' }">{{ item.desc }}</p>
            </div>
          </div>
        </div>

        <div class="relative text-xs tracking-[0.2em] uppercase" :style="{ color: 'var(--text-muted)' }">
          Writing Workspace
        </div>
      </section>

      <!-- 登录表单 -->
      <section class="flex min-h-full items-center justify-center px-5 py-10">
        <div class="w-full max-w-md">
          <div class="mb-10 text-center lg:hidden">
            <div class="eyebrow justify-center flex items-center gap-2">
              <span class="h-1.5 w-1.5 rounded-full bg-brand inline-block"></span>
              AI Writing Assistant
            </div>
            <h1 class="mt-4 font-serif text-3xl font-semibold" :style="{ color: 'var(--text-primary)' }">
              把长篇创作，写成可控的过程。
            </h1>
          </div>

          <div class="card p-8 animate-pop-in stagger-2">
            <h2 class="font-serif text-2xl font-semibold" :style="{ color: 'var(--text-primary)' }">
              {{ isLogin ? '欢迎回来' : '创建账号' }}
            </h2>
            <p class="mt-2 text-sm" :style="{ color: 'var(--text-muted)' }">
              {{ isLogin ? '登录后继续你的写作工作台。' : '注册后可初始化示例作品，体验完整流程。' }}
            </p>

            <div class="mt-6 grid grid-cols-2 rounded-xl p-1"
              :style="{ backgroundColor: 'var(--surface-secondary)' }">
              <button type="button" @click="isLogin = true; errorMsg = ''"
                class="rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150"
                :style="isLogin
                  ? { backgroundColor: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-soft)' }
                  : { color: 'var(--text-muted)' }">
                登录
              </button>
              <button type="button" @click="isLogin = false; errorMsg = ''"
                class="rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150"
                :style="!isLogin
                  ? { backgroundColor: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-soft)' }
                  : { color: 'var(--text-muted)' }">
                注册
              </button>
            </div>

            <form @submit.prevent="handleSubmit" class="mt-6 space-y-4">
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

              <div v-if="errorMsg" class="rounded-xl px-4 py-3 text-sm"
                :style="{ backgroundColor: '#f9e3dd', color: '#a0432c' }">
                {{ errorMsg }}
              </div>

              <button type="submit" :disabled="isLoading || !email || !password"
                class="btn-primary w-full py-3">
                {{ isLoading ? '处理中...' : (isLogin ? '登录工作台' : '创建并进入') }}
              </button>
            </form>

            <div class="mt-6 text-center text-sm" :style="{ color: 'var(--text-muted)' }">
              {{ isLogin ? '还没有账号？' : '已有账号？' }}
              <button @click="toggleMode" class="font-medium transition-colors"
                :style="{ color: 'var(--brand-hover)' }">
                {{ isLogin ? '去注册' : '去登录' }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
