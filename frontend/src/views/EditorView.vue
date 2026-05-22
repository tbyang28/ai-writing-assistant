<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBookStore, type Chapter, type Outline, type Character } from '@/stores/book'
import { useAiStore } from '@/stores/ai'
import AiPanel from '@/components/AiPanel.vue'

const route = useRoute()
const router = useRouter()
const bookStore = useBookStore()
const aiStore = useAiStore()

const bookId = computed(() => route.params.id as string)
const activeChapterId = ref<string | null>(null)
const editorContent = ref('')
const editorTitle = ref('')
const saveTimer = ref<any>(null)
const saving = ref(false)
const showOutline = ref(false)
const showCharacters = ref(false)

// New item modals
const showNewChapterModal = ref(false)
const newChapterTitle = ref('')
const showNewOutlineModal = ref(false)
const newOutlineTitle = ref('')
const showNewCharacterModal = ref(false)
const newCharacterName = ref('')
const newCharacterRole = ref('')
const showNewInspirationModal = ref(false)
const newInspirationTitle = ref('')
const newInspirationContent = ref('')

onMounted(async () => {
  if (bookId.value) {
    await bookStore.fetchBook(bookId.value)
    const chapters = bookStore.currentBook?.chapters || []
    if (chapters.length > 0) {
      activeChapterId.value = chapters[0].id
      await loadChapter(chapters[0].id)
    }
  }
})

const chapters = computed(() => bookStore.currentBook?.chapters || [])
const outlines = computed(() => bookStore.currentBook?.outlines || [])
const characters = computed(() => bookStore.currentBook?.characters || [])
const inspirations = computed(() => bookStore.currentBook?.inspirations || [])

async function loadChapter(id: string) {
  activeChapterId.value = id
  const chapter = await bookStore.fetchChapter(id)
  if (chapter) {
    editorContent.value = chapter.content || ''
    editorTitle.value = chapter.title || '未命名章节'
  }
}

async function selectChapter(id: string) {
  await saveCurrentChapter()
  await loadChapter(id)
}

async function saveCurrentChapter() {
  if (!activeChapterId.value) return
  saving.value = true
  try {
    await bookStore.saveChapter(activeChapterId.value, {
      title: editorTitle.value,
      content: editorContent.value,
    })
  } finally {
    saving.value = false
  }
}

function autoSave() {
  if (saveTimer.value) clearTimeout(saveTimer.value)
  saveTimer.value = setTimeout(() => {
    saveCurrentChapter()
  }, 2000)
}

watch(editorContent, () => autoSave())
watch(editorTitle, () => autoSave())

async function createChapter() {
  if (!newChapterTitle.value.trim()) return
  await bookStore.createChapter(bookId.value, { title: newChapterTitle.value.trim() })
  newChapterTitle.value = ''
  showNewChapterModal.value = false
}

async function createOutline() {
  if (!newOutlineTitle.value.trim()) return
  await bookStore.createOutline(bookId.value, { title: newOutlineTitle.value.trim() })
  newOutlineTitle.value = ''
  showNewOutlineModal.value = false
}

async function createCharacter() {
  if (!newCharacterName.value.trim()) return
  await bookStore.createCharacter(bookId.value, {
    name: newCharacterName.value.trim(),
    role: newCharacterRole.value || undefined,
  })
  newCharacterName.value = ''
  newCharacterRole.value = ''
  showNewCharacterModal.value = false
}

async function createInspiration() {
  if (!newInspirationTitle.value.trim() || !newInspirationContent.value.trim()) return
  await bookStore.createInspiration(bookId.value, {
    title: newInspirationTitle.value.trim(),
    content: newInspirationContent.value.trim(),
  })
  newInspirationTitle.value = ''
  newInspirationContent.value = ''
  showNewInspirationModal.value = false
}

async function deleteChapter(chapter: Chapter) {
  if (!confirm(`确定删除《${chapter.title}》吗？`)) return
  await bookStore.deleteChapter(chapter.id)
  const chs = bookStore.currentBook?.chapters || []
  if (chs.length > 0) {
    await loadChapter(chs[0].id)
  } else {
    activeChapterId.value = null
    editorContent.value = ''
    editorTitle.value = ''
  }
}

function applyAiText(text: string) {
  if (text) {
    editorContent.value += '\n' + text
  }
}
</script>

<template>
  <div class="flex-1 flex min-h-0">
    <!-- Left sidebar - chapters & outlines -->
    <div class="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
      <!-- Book info -->
      <div class="p-3 border-b border-gray-100">
        <div class="flex items-center justify-between">
          <button @click="router.push('/')" class="text-sm text-gray-500 hover:text-gray-700">
            ← 返回
          </button>
          <span v-if="saving" class="text-xs text-gray-400">保存中...</span>
          <span v-else class="text-xs text-gray-300">已保存</span>
        </div>
        <h2 class="text-sm font-semibold text-gray-900 mt-1 truncate">{{ bookStore.currentBook?.title }}</h2>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-gray-100">
        <button @click="showOutline = false; showCharacters = false"
          class="flex-1 py-2 text-xs font-medium"
          :class="!showOutline && !showCharacters ? 'text-brand border-b-2 border-brand' : 'text-gray-500'">
          章节
        </button>
        <button @click="showOutline = true; showCharacters = false"
          class="flex-1 py-2 text-xs font-medium"
          :class="showOutline ? 'text-brand border-b-2 border-brand' : 'text-gray-500'">
          大纲
        </button>
        <button @click="showCharacters = true; showOutline = false"
          class="flex-1 py-2 text-xs font-medium"
          :class="showCharacters ? 'text-brand border-b-2 border-brand' : 'text-gray-500'">
          角色
        </button>
      </div>

      <!-- Chapters list -->
      <div v-if="!showOutline && !showCharacters" class="flex-1 overflow-y-auto">
        <div class="p-2">
          <button @click="showNewChapterModal = true" class="w-full flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:bg-brand-50 rounded-lg">
            + 新建章节
          </button>
        </div>
        <div v-for="ch in chapters" :key="ch.id"
          @click="selectChapter(ch.id)"
          class="px-3 py-2 cursor-pointer text-sm border-b border-gray-50 hover:bg-gray-50"
          :class="{ 'bg-brand-50 text-brand': activeChapterId === ch.id }">
          <div class="font-medium truncate">{{ ch.title }}</div>
          <div class="text-xs text-gray-400 mt-0.5">{{ ch.word_count }}字</div>
        </div>
        <div v-if="chapters.length === 0" class="text-center py-8 text-sm text-gray-400">
          暂无章节
        </div>
      </div>

      <!-- Outlines -->
      <div v-else-if="showOutline" class="flex-1 overflow-y-auto">
        <div class="p-2">
          <button @click="showNewOutlineModal = true" class="w-full flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:bg-brand-50 rounded-lg">
            + 新建大纲
          </button>
        </div>
        <div v-for="ol in outlines" :key="ol.id" class="px-3 py-2 border-b border-gray-50">
          <div class="font-medium text-sm">{{ ol.title }}</div>
          <div class="text-xs text-gray-500 mt-1 whitespace-pre-wrap line-clamp-3">{{ ol.content }}</div>
        </div>
        <div v-if="outlines.length === 0" class="text-center py-8 text-sm text-gray-400">
          暂无大纲
        </div>
      </div>

      <!-- Characters -->
      <div v-else class="flex-1 overflow-y-auto">
        <div class="p-2">
          <button @click="showNewCharacterModal = true" class="w-full flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:bg-brand-50 rounded-lg">
            + 新建角色
          </button>
        </div>
        <div v-for="ch in characters" :key="ch.id" class="px-3 py-2 border-b border-gray-50">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full bg-brand text-white flex items-center justify-center text-xs font-bold">
              {{ ch.name[0] }}
            </div>
            <div>
              <div class="text-sm font-medium">{{ ch.name }}</div>
              <div v-if="ch.role" class="text-xs text-gray-400">{{ ch.role }}</div>
            </div>
          </div>
          <div v-if="ch.bio" class="text-xs text-gray-500 mt-1 ml-8">{{ ch.bio }}</div>
        </div>
        <div v-if="characters.length === 0" class="text-center py-8 text-sm text-gray-400">
          暂无角色
        </div>
      </div>

      <!-- Inspirations at bottom -->
      <div class="border-t border-gray-100">
        <button @click="showNewInspirationModal = true" class="w-full px-3 py-2 text-xs text-brand hover:bg-brand-50 text-left">
          + 记录灵感
        </button>
        <div v-for="ins in inspirations.slice(0, 3)" :key="ins.id" class="px-3 py-1.5 border-t border-gray-50">
          <div class="text-xs font-medium">{{ ins.title }}</div>
        </div>
      </div>
    </div>

    <!-- Editor area -->
    <div class="flex-1 flex flex-col min-w-0 bg-white">
      <!-- Title bar -->
      <div class="h-12 border-b border-gray-200 flex items-center px-4 gap-2">
        <input v-model="editorTitle" class="flex-1 text-base font-medium text-gray-900 border-none outline-none bg-transparent" placeholder="章节标题" />
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-400">{{ editorContent.length }} 字</span>
          <button @click="aiStore.openPanel()" class="btn-secondary text-xs px-2 py-1">
            AI 助手
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto">
        <div v-if="activeChapterId" class="max-w-3xl mx-auto p-6">
          <textarea
            v-model="editorContent"
            class="w-full min-h-[70vh] text-base leading-relaxed text-gray-800 border-none outline-none resize-none bg-transparent font-serif"
            placeholder="开始写作..."
          ></textarea>
        </div>
        <div v-else class="flex items-center justify-center h-full text-gray-400">
          <div class="text-center">
            <p class="mb-2">请选择或创建一个章节</p>
            <button @click="showNewChapterModal = true" class="btn-primary text-sm">新建章节</button>
          </div>
        </div>
      </div>
    </div>

    <!-- AI Panel -->
    <AiPanel
      v-if="aiStore.isPanelOpen"
      :book-id="bookId"
      :chapter-content="editorContent"
      :chapter-id="activeChapterId || undefined"
      @apply-text="applyAiText"
    />

    <!-- Modals -->
    <div v-if="showNewChapterModal" class="modal-overlay" @click.self="showNewChapterModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4">新建章节</h3>
        <input v-model="newChapterTitle" type="text" class="form-input" placeholder="章节标题" @keyup.enter="createChapter" />
        <div class="flex justify-end gap-3 mt-4">
          <button @click="showNewChapterModal = false" class="btn-secondary">取消</button>
          <button @click="createChapter" :disabled="!newChapterTitle.trim()" class="btn-primary">创建</button>
        </div>
      </div>
    </div>

    <div v-if="showNewOutlineModal" class="modal-overlay" @click.self="showNewOutlineModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4">新建大纲</h3>
        <input v-model="newOutlineTitle" type="text" class="form-input" placeholder="大纲标题" @keyup.enter="createOutline" />
        <div class="flex justify-end gap-3 mt-4">
          <button @click="showNewOutlineModal = false" class="btn-secondary">取消</button>
          <button @click="createOutline" :disabled="!newOutlineTitle.trim()" class="btn-primary">创建</button>
        </div>
      </div>
    </div>

    <div v-if="showNewCharacterModal" class="modal-overlay" @click.self="showNewCharacterModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4">新建角色</h3>
        <div class="space-y-3">
          <input v-model="newCharacterName" type="text" class="form-input" placeholder="角色名称" />
          <input v-model="newCharacterRole" type="text" class="form-input" placeholder="角色类型（可选）" />
        </div>
        <div class="flex justify-end gap-3 mt-4">
          <button @click="showNewCharacterModal = false" class="btn-secondary">取消</button>
          <button @click="createCharacter" :disabled="!newCharacterName.trim()" class="btn-primary">创建</button>
        </div>
      </div>
    </div>

    <div v-if="showNewInspirationModal" class="modal-overlay" @click.self="showNewInspirationModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4">记录灵感</h3>
        <div class="space-y-3">
          <input v-model="newInspirationTitle" type="text" class="form-input" placeholder="灵感标题" />
          <textarea v-model="newInspirationContent" rows="3" class="form-textarea" placeholder="灵感内容" />
        </div>
        <div class="flex justify-end gap-3 mt-4">
          <button @click="showNewInspirationModal = false" class="btn-secondary">取消</button>
          <button @click="createInspiration" :disabled="!newInspirationTitle.trim() || !newInspirationContent.trim()" class="btn-primary">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
