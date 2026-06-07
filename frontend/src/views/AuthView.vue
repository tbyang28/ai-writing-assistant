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
  <div class="flex-1 min-h-0 overflow-auto bg-[#0f172a] text-white">
    <div class="min-h-full grid lg:grid-cols-[1.08fr_0.92fr]">
      <section class="relative hidden lg:flex flex-col justify-between overflow-hidden px-12 py-10 xl:px-16">
        <div class="absolute inset-0 bg-[radial-gradient(circle_at_26%_18%,rgba(34,211,238,0.18),transparent_30%),radial-gradient(circle_at_72%_74%,rgba(99,102,241,0.22),transparent_32%)]"></div>
        <div class="absolute inset-0 opacity-[0.08]"
          style="background-image: linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px); background-size: 56px 56px;"></div>

        <div class="relative">
          <div class="inline-flex items-center gap-3 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200">
            <span class="h-2 w-2 rounded-full bg-cyan-300"></span>
            Writing Workspace
          </div>
          <h1 class="mt-8 max-w-2xl text-5xl font-semibold leading-tight tracking-normal xl:text-6xl">
            把长篇创作整理成可管理的工作台
          </h1>
          <p class="mt-6 max-w-xl text-base leading-8 text-slate-300">
            管理作品、章节、人物和关系图，在需要时用 AI 续写、润色、校对与检索历史设定。
          </p>
        </div>

        <div class="relative grid max-w-2xl grid-cols-2 gap-4">
          <div class="rounded-2xl border border-white/10 bg-white/8 p-5">
            <div class="text-sm font-semibold text-cyan-200">RAG Context</div>
            <div class="mt-3 text-lg font-semibold">召回历史设定</div>
            <p class="mt-2 text-sm leading-6 text-slate-300">续写前检索相关章节，减少人物和剧情遗忘。</p>
          </div>
          <div class="rounded-2xl border border-white/10 bg-white/8 p-5">
            <div class="text-sm font-semibold text-violet-200">Story Map</div>
            <div class="mt-3 text-lg font-semibold">人物关系图谱</div>
            <p class="mt-2 text-sm leading-6 text-slate-300">沉淀角色、阵营和冲突，适合长篇回看设定。</p>
          </div>
          <div class="rounded-2xl border border-white/10 bg-white/8 p-5">
            <div class="text-sm font-semibold text-emerald-200">AI Diff</div>
            <div class="mt-3 text-lg font-semibold">可控润色</div>
            <p class="mt-2 text-sm leading-6 text-slate-300">先看修改差异，再决定是否写回正文。</p>
          </div>
          <div class="rounded-2xl border border-white/10 bg-white/8 p-5">
            <div class="text-sm font-semibold text-amber-200">Demo Ready</div>
            <div class="mt-3 text-lg font-semibold">示例作品初始化</div>
            <p class="mt-2 text-sm leading-6 text-slate-300">一键生成章节、人物和关系，快速体验完整链路。</p>
          </div>
        </div>
      </section>

      <section class="flex min-h-full items-center justify-center px-5 py-10 lg:bg-[#111827]/65">
        <div class="w-full max-w-md">
          <div class="mb-8 lg:hidden">
            <div class="text-xs uppercase tracking-[0.22em] text-cyan-300">Writing Workspace</div>
            <h1 class="mt-3 text-3xl font-semibold tracking-normal">AI 写作助手</h1>
            <p class="mt-3 text-sm leading-6 text-slate-300">管理作品，并用 AI 辅助续写、润色和整理角色。</p>
          </div>

          <div class="rounded-2xl border border-white/10 bg-slate-900/85 p-6 shadow-2xl shadow-black/25 backdrop-blur">
            <div class="flex items-start justify-between gap-4">
              <div>
                <div class="text-xs uppercase tracking-[0.2em] text-cyan-300">AI Writing Assistant</div>
                <h2 class="mt-3 text-2xl font-semibold">
                  {{ isLogin ? '欢迎回来' : '创建账号' }}
                </h2>
                <p class="mt-2 text-sm text-slate-400">
                  {{ isLogin ? '登录后继续你的写作工作台。' : '注册后可以初始化示例作品体验完整流程。' }}
                </p>
              </div>
              <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-lg font-bold">
                AI
              </div>
            </div>

            <div class="mt-6 grid grid-cols-2 rounded-xl border border-white/10 bg-slate-950/70 p-1">
              <button type="button" @click="isLogin = true; errorMsg = ''"
                :class="['rounded-lg px-3 py-2 text-sm font-medium transition-colors', isLogin ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white']">
                登录
              </button>
              <button type="button" @click="isLogin = false; errorMsg = ''"
                :class="['rounded-lg px-3 py-2 text-sm font-medium transition-colors', !isLogin ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white']">
                注册
              </button>
            </div>

            <form @submit.prevent="handleSubmit" class="mt-6 space-y-4">
              <div v-if="!isLogin">
                <label class="mb-2 block text-sm font-medium text-slate-300">昵称</label>
                <input v-model="name" type="text"
                  class="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20"
                  placeholder="你的昵称（可选）" />
              </div>
              <div>
                <label class="mb-2 block text-sm font-medium text-slate-300">邮箱</label>
                <input v-model="email" type="email"
                  class="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20"
                  placeholder="请输入邮箱" required />
              </div>
              <div>
                <label class="mb-2 block text-sm font-medium text-slate-300">密码</label>
                <input v-model="password" type="password"
                  class="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20"
                  placeholder="请输入密码" required />
              </div>

              <div v-if="errorMsg" class="rounded-xl border border-red-400/20 bg-red-500/12 px-4 py-3 text-sm text-red-200">
                {{ errorMsg }}
              </div>

              <button type="submit" :disabled="isLoading || !email || !password"
                class="inline-flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-950/25 transition hover:from-indigo-400 hover:to-cyan-400 disabled:cursor-not-allowed disabled:opacity-55">
                {{ isLoading ? '处理中...' : (isLogin ? '登录工作台' : '创建并进入') }}
              </button>
            </form>

            <div class="mt-5 text-center text-sm text-slate-400">
              {{ isLogin ? '还没有账号？' : '已有账号？' }}
              <button @click="toggleMode" class="font-medium text-cyan-300 hover:text-cyan-200">
                {{ isLogin ? '去注册' : '去登录' }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
