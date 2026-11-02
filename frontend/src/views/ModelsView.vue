<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useLocalProviderCatalog } from '@/composables/useLocalProviderCatalog'
import { providerLabel, type LocalConnection } from '@/stores/localProviders'

const catalog = useLocalProviderCatalog()
const auth = useAuthStore()
const codeInput = ref<HTMLInputElement | null>(null)
const copyMessage = ref('')
const notice = ref('')
const confirmation = ref<{ id: string; action: 'enable' | 'revoke' } | null>(null)
const confirmBox = ref<HTMLElement | null>(null)
const confirmedConnection = computed(() => catalog.connections.find(item => item.id === confirmation.value?.id))
const expiresLabel = computed(() => catalog.pairing ? new Date(catalog.pairing.expiresAt).toLocaleTimeString() : '')
const command = computed(() => {
  try {
    const url = new URL(api.defaults.baseURL || '/api', window.location.origin)
    url.pathname = url.pathname.replace(/\/$/, '')
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api')) return null
    const root = url.href.replace(/'/g, "'\\''")
    return `npm start -- --server '${root}'`
  } catch { return null }
})
watch(() => [auth.token, auth.user?.id], () => {
  confirmation.value = null
  copyMessage.value = ''
  notice.value = ''
}, { flush: 'sync' })
watch(() => catalog.pairing?.code, () => { copyMessage.value = '' })
onBeforeUnmount(() => catalog.clearPairing())

async function copyCode() {
  const code = catalog.pairing?.code
  if (!code) return
  try {
    await navigator.clipboard.writeText(code)
    if (catalog.pairing?.code === code) copyMessage.value = '已复制，请在本机连接器的提示中粘贴。'
  } catch {
    if (catalog.pairing?.code !== code) return
    copyMessage.value = '自动复制失败，已选中配对码，请手动复制。'
    codeInput.value?.focus()
    codeInput.value?.select()
  }
}
async function ask(connection: LocalConnection, action: 'enable' | 'revoke') {
  confirmation.value = { id: connection.id, action }
  await nextTick()
  confirmBox.value?.focus()
}
async function confirmAction() {
  const target = confirmation.value
  if (!target) return
  const success = await catalog.changeConnection(target.id, target.action === 'enable' ? true : undefined)
  if (success && confirmation.value === target) {
    confirmation.value = null
    notice.value = target.action === 'enable' ? '已允许此设备接收作品上下文。现在可在编辑器 AI 助手中选择它的模型。' : '连接已撤销。重新连接需要再次启动本机组件并配对。'
  }
}
function lastSeen(connection: LocalConnection) {
  return connection.lastSeenAt ? new Date(connection.lastSeenAt).toLocaleString() : '尚未收到心跳'
}
</script>

<template>
  <div class="models-page flex-1 min-h-0 overflow-auto">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <header class="pt-4">
        <p class="eyebrow">Model connections</p>
        <h1 class="mt-4 font-serif text-3xl sm:text-4xl font-semibold">模型连接</h1>
        <p class="secondary mt-3 max-w-2xl text-sm leading-7">把你电脑上的 Ollama / LM Studio 接入写作助手。先在本机启动连接器，完成配对并明确启用，再到编辑器选择模型。</p>
      </header>

      <section class="card p-5 sm:p-6" aria-labelledby="boundary-heading">
        <h2 id="boundary-heading" class="font-semibold">连接前，你需要了解</h2>
        <ul class="secondary mt-3 text-sm leading-7 list-disc pl-5 space-y-1">
          <li>需要你主动安装并运行本地组件；云端不能扫描你的电脑。连接器只连接本机固定端口的 Ollama / LM Studio。</li>
          <li>配对时上传设备名称、模型清单与能力，以及已检测到的 CLI 名称。不读取或导入 CLI OAuth、Keychain、登录文件或 API 密钥。</li>
          <li>启用后，写作请求的作品上下文会发送到此设备，模型生成在本地执行；作品记忆与 embedding 仍由平台处理，并非完全离线。</li>
        </ul>
      </section>

      <section class="card p-5 sm:p-6" aria-labelledby="pair-heading">
        <h2 id="pair-heading" class="font-serif text-xl font-semibold">连接一台电脑</h2>
        <ol class="mt-5 space-y-5 text-sm leading-7">
          <li>
            <h3 class="font-semibold">1. 在自己的电脑准备模型与可信连接器</h3>
            <p class="secondary mt-1">启动 Ollama（端口 11434）或 LM Studio 的本地服务（端口 1234），准备好可调用的模型。检测到 CLI 不代表模型可用。</p>
            <p class="secondary mt-1">从本项目的<a class="source-link" href="https://github.com/tbyang28/ai-writing-assistant" target="_blank" rel="noopener noreferrer">可信 GitHub 仓库（新窗口）</a>获取源码，核对仓库来源后，在这台电脑的终端执行：</p>
            <pre class="command mt-2"><code>git clone https://github.com/tbyang28/ai-writing-assistant.git
cd ai-writing-assistant/local-connector
npm install</code></pre>
          </li>
          <li>
            <h3 class="font-semibold">2. 生成一次性配对码</h3>
            <p class="secondary mt-1">有效期 5 分钟，仅可使用一次；生成新码将废除旧码。配对码仅在本页内存中展示，请勿分享。</p>
            <button type="button" class="btn-secondary mt-3" :disabled="catalog.pairingBusy" @click="catalog.createPairing()">{{ catalog.pairingBusy ? '正在生成…' : catalog.pairing ? '重新生成配对码' : '生成配对码' }}</button>
            <div v-if="catalog.pairing" class="inset-panel mt-3 p-4 space-y-2">
              <label for="pairing-code" class="block font-medium">一次性配对码</label>
              <input id="pairing-code" ref="codeInput" class="form-input font-mono" :value="catalog.pairing.code" readonly autocomplete="off" spellcheck="false" @focus="codeInput?.select()" />
              <div class="flex flex-wrap items-center gap-3">
                <button type="button" class="btn-secondary" @click="copyCode">复制配对码</button>
                <span class="secondary text-xs">{{ expiresLabel }} 到期，过期后将自动隐藏</span>
              </div>
            </div>
            <p v-if="copyMessage" class="secondary mt-2" role="status">{{ copyMessage }}</p>
            <p v-if="catalog.pairingError" class="feedback mt-2" role="alert">{{ catalog.pairingError }}，可点击生成按钮重试。</p>
          </li>
          <li>
            <h3 class="font-semibold">3. 启动连接器，在提示中输入配对码</h3>
            <p class="secondary mt-1">在 local-connector 目录执行下方命令，按提示阅读传输说明并输入配对码。不要把配对码放进命令行、日志或截图。连接器需保持运行，每次重启需要重新配对。</p>
            <pre v-if="command" class="command mt-2"><code>{{ command }}</code></pre>
            <p v-else class="feedback mt-2" role="alert">当前 API 地址不符合连接器要求。请配置以 /api 结尾的 HTTPS API 地址；本机开发可使用 loopback HTTP 地址。</p>
            <p class="secondary mt-2">成功后在下方刷新连接。新连接默认禁用，点击“启用”并确认传输范围后，才可选择模型。</p>
          </li>
        </ol>
      </section>

      <section aria-labelledby="connections-heading" class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 id="connections-heading" class="font-serif text-xl font-semibold">我的设备连接</h2>
          <button type="button" class="btn-secondary" :disabled="catalog.refreshing" @click="catalog.refresh()">{{ catalog.refreshing ? '正在刷新…' : '刷新连接' }}</button>
        </div>
        <p class="secondary text-xs leading-6">本页可见时每 30 秒刷新。在线状态由服务端按最近 30 秒的心跳判断，禁用的设备也可以在线。离线、禁用或撤销后不会自动切换云端模型。</p>
        <div v-if="catalog.error" class="inset-panel p-4 text-sm" role="alert">
          <p>{{ catalog.error }}。列表可能尚未更新。</p>
          <button type="button" class="btn-secondary mt-2" :disabled="catalog.refreshing" @click="catalog.refresh()">重试加载</button>
        </div>
        <p v-if="notice" class="inset-panel p-4 text-sm" role="status">{{ notice }}</p>
        <p v-if="!catalog.loaded && catalog.refreshing" class="secondary py-6 text-sm" role="status">正在加载设备连接…</p>
        <div v-else-if="catalog.loaded && !catalog.connections.length" class="card p-8 text-center">
          <h3 class="font-serif text-lg font-semibold">还没有设备连接</h3>
          <p class="secondary mt-2 text-sm leading-6">按上方步骤完成配对后，设备会出现在这里。</p>
        </div>
        <article v-for="connection in catalog.connections" :key="connection.id" class="card p-5 sm:p-6 space-y-4" :aria-label="connection.name">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="font-semibold break-words">{{ connection.name }}</h3>
              <div class="flex flex-wrap gap-2 mt-2 text-xs"><span class="badge">{{ connection.online ? '在线' : '离线' }}</span><span class="badge">{{ connection.enabled ? '已启用' : '未启用' }}</span></div>
              <p class="secondary mt-2 text-xs leading-6">最近心跳：{{ lastSeen(connection) }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <button v-if="!connection.enabled" type="button" class="btn-primary" :disabled="catalog.pending[connection.id]" @click="ask(connection, 'enable')">启用</button>
              <button v-else type="button" class="btn-secondary" :disabled="catalog.pending[connection.id]" @click="catalog.changeConnection(connection.id, false)">{{ catalog.pending[connection.id] ? '处理中…' : '禁用' }}</button>
              <button type="button" class="btn-secondary" :disabled="catalog.pending[connection.id]" @click="ask(connection, 'revoke')">撤销连接</button>
            </div>
          </div>
          <div v-for="provider in connection.providers" :key="provider.id" class="inset-panel p-3 text-sm">
            <h4 class="font-semibold">{{ providerLabel(provider.id) }}</h4>
            <ul v-if="provider.models.length" class="mt-2 space-y-2">
              <li v-for="model in provider.models" :key="model.model" class="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <span class="break-words min-w-0">{{ model.label }}</span>
                <span class="secondary text-xs leading-6">{{ model.tools ? '支持工具调用' : '不支持工具调用（服务端自动禁用工具）' }}<template v-if="model.contextWindow"> · 上下文 {{ model.contextWindow.toLocaleString() }}</template></span>
              </li>
            </ul>
            <p v-else class="secondary mt-1">尚未发现可调用模型，请检查本机服务。</p>
          </div>
          <p v-if="!connection.providers.some(provider => provider.models.length)" class="secondary text-sm">未发现可调用模型。请在本机启动模型服务并加载模型，再刷新。</p>
          <p v-if="connection.detectedClis.length" class="secondary text-xs leading-6">检测到 CLI：{{ connection.detectedClis.join('、') }}。仅检测是否存在，未运行、未读取登录凭证，也不代表可以调用。</p>
          <div v-if="confirmation?.id === connection.id && confirmedConnection" :ref="element => { confirmBox = element as HTMLElement | null }" tabindex="-1" class="inset-panel p-4 text-sm leading-7" role="region" :aria-label="confirmation.action === 'enable' ? '确认启用设备' : '确认撤销连接'">
            <template v-if="confirmation.action === 'enable'">
              <h4 class="font-semibold">允许将作品上下文发送到“{{ connection.name }}”？</h4>
              <p class="secondary mt-1">选择此设备的模型生成时，作品信息、人物、大纲、相关章节、作品记忆和当前草稿等上下文会发送到此设备。请确认这是你信任的电脑。启用后仍需在编辑器选择模型。</p>
            </template>
            <template v-else>
              <h4 class="font-semibold">确认撤销“{{ connection.name }}”的连接？</h4>
              <p class="secondary mt-1">将撤销访问令牌并取消此设备排队中或正在执行的任务。再次连接需要重新配对；当前选中的模型不会自动切换到云端。</p>
            </template>
            <div class="flex flex-wrap gap-2 mt-3">
              <button type="button" class="btn-primary" :disabled="catalog.pending[connection.id]" @click="confirmAction">{{ catalog.pending[connection.id] ? '处理中…' : confirmation.action === 'enable' ? '允许传输上下文并启用' : '确认撤销连接' }}</button>
              <button type="button" class="btn-secondary" :disabled="catalog.pending[connection.id]" @click="confirmation = null">取消</button>
            </div>
          </div>
          <p v-if="catalog.actionErrors[connection.id]" class="feedback text-sm" role="alert">{{ catalog.actionErrors[connection.id] }}。请使用原操作按钮重试。</p>
        </article>
      </section>
    </div>
  </div>
</template>

<style scoped>
.models-page { background: var(--bg-page); color: var(--text-primary); }
.secondary { color: var(--text-secondary); }
.inset-panel, .command { background: var(--surface-secondary); border: 1px solid var(--border-clr); border-radius: 12px; }
.command { padding: 12px 16px; overflow-x: auto; max-width: 100%; font-size: 12px; line-height: 1.8; }
.badge { padding: 4px 10px; border-radius: 6px; background: var(--surface-secondary); color: var(--text-secondary); }
.feedback { color: var(--text-primary); border-left: 3px solid var(--brand); padding-left: 12px; }
.source-link { text-decoration: underline; text-underline-offset: 3px; }
.models-page button { min-height: 44px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
.models-page button:disabled { opacity: .55; cursor: not-allowed; }
.models-page :is(button, input, a, [tabindex]):focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.models-page article, .models-page li { overflow-wrap: anywhere; }
</style>
