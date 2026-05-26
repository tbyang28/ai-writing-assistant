<script setup lang="ts">
import { onMounted, ref, computed, watch, nextTick } from 'vue'
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

// Undo for AI insert
const undoSnapshot = ref('')
const showAiUndo = ref(false)
let undoHideTimer: ReturnType<typeof setTimeout> | null = null

// Resizable panels
const leftPanelWidth = ref(224)       // default: w-56 = 14rem = 224px
const rightPanelWidth = ref(320)      // default: w-80 = 20rem = 320px
const isDragging = ref<'left' | 'right' | null>(null)
const dragStartX = ref(0)
const dragStartWidth = ref(0)

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
const selectionStart = ref(0)
const selectionEnd = ref(0)

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
    undoSnapshot.value = editorContent.value
    editorContent.value += text
    showAiUndo.value = true
    if (undoHideTimer) clearTimeout(undoHideTimer)
    undoHideTimer = setTimeout(() => { showAiUndo.value = false }, 5000)
  }
}

function replaceAiText(text: string) {
  if (!text) return
  undoSnapshot.value = editorContent.value

  if (selectionEnd.value > selectionStart.value) {
    editorContent.value =
      editorContent.value.slice(0, selectionStart.value) +
      text +
      editorContent.value.slice(selectionEnd.value)
    selectionEnd.value = selectionStart.value + text.length
  } else {
    editorContent.value = text
    selectionStart.value = 0
    selectionEnd.value = text.length
  }

  showAiUndo.value = true
  if (undoHideTimer) clearTimeout(undoHideTimer)
  undoHideTimer = setTimeout(() => { showAiUndo.value = false }, 5000)
  nextTick(autoResizeTextarea)
}

function undoAiInsert() {
  editorContent.value = undoSnapshot.value
  showAiUndo.value = false
  if (undoHideTimer) clearTimeout(undoHideTimer)
}

// === Auto-resize textarea ===
const textareaRef = ref<HTMLTextAreaElement | null>(null)

function autoResizeTextarea() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

function updateEditorSelection() {
  const el = textareaRef.value
  if (!el) return
  selectionStart.value = el.selectionStart
  selectionEnd.value = el.selectionEnd
  aiStore.setSelectedText(editorContent.value.slice(selectionStart.value, selectionEnd.value))
}

watch(editorContent, () => {
  nextTick(autoResizeTextarea)
})

// === Resizable panel drag ===
function startDrag(e: MouseEvent, side: 'left' | 'right') {
  isDragging.value = side
  dragStartX.value = e.clientX
  dragStartWidth.value = side === 'left' ? leftPanelWidth.value : rightPanelWidth.value
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopDrag)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onDrag(e: MouseEvent) {
  if (!isDragging.value) return
  const dx = e.clientX - dragStartX.value
  if (isDragging.value === 'left') {
    leftPanelWidth.value = Math.max(160, Math.min(400, dragStartWidth.value + dx))
  } else {
    rightPanelWidth.value = Math.max(240, Math.min(500, dragStartWidth.value - dx))
  }
}

function stopDrag() {
  isDragging.value = null
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}
</script>

<template>
  <div class="flex-1 flex min-h-0 overflow-hidden">
    <!-- Left sidebar - chapters & outlines -->
    <div class="flex flex-col shrink-0 border-r" :style="{ width: leftPanelWidth + 'px', backgroundColor: 'var(--surface)', borderRightColor: 'var(--border-clr)' }">
      <!-- Book info -->
      <div class="p-3 border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
        <div class="flex items-center justify-between">
          <button @click="router.push('/')" class="text-sm" :class="'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'">
            ← 返回
          </button>
          <span v-if="saving" class="text-xs" :style="{ color: 'var(--text-muted)' }">保存中...</span>
          <span v-else class="text-xs" :style="{ color: 'var(--text-muted)' }">已保存</span>
        </div>
        <h2 class="text-sm font-semibold mt-1 truncate" :style="{ color: 'var(--text-primary)' }">{{ bookStore.currentBook?.title }}</h2>
      </div>

      <!-- Tabs -->
      <div class="flex border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
        <button @click="showOutline = false; showCharacters = false"
          class="flex-1 py-2 text-xs font-medium"
          :class="!showOutline && !showCharacters ? 'text-brand border-b-2 border-brand' : 'text-gray-500 dark:text-gray-400'">
          章节
        </button>
        <button @click="showOutline = true; showCharacters = false"
          class="flex-1 py-2 text-xs font-medium"
          :class="showOutline ? 'text-brand border-b-2 border-brand' : 'text-gray-500 dark:text-gray-400'">
          大纲
        </button>
        <button @click="showCharacters = true; showOutline = false"
          class="flex-1 py-2 text-xs font-medium"
          :class="showCharacters ? 'text-brand border-b-2 border-brand' : 'text-gray-500 dark:text-gray-400'">
          角色
        </button>
      </div>

      <!-- Chapters list -->
      <div v-if="!showOutline && !showCharacters" class="flex-1 overflow-y-auto">
        <div class="p-2">
          <button @click="showNewChapterModal = true" class="w-full flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:bg-brand-50 dark:hover:bg-brand-900/30 rounded-lg">
            + 新建章节
          </button>
        </div>
        <div v-for="ch in chapters" :key="ch.id"
          @click="selectChapter(ch.id)"
          class="px-3 py-2 cursor-pointer text-sm border-b hover:bg-gray-50 dark:hover:bg-gray-800"
          :class="{ 'bg-brand-50 text-brand dark:bg-brand-900/30': activeChapterId === ch.id }"
          :style="{ borderBottomColor: 'var(--border-clr)' }">
          <div class="font-medium truncate" :style="{ color: 'var(--text-primary)' }">{{ ch.title }}</div>
          <div class="text-xs mt-0.5" :style="{ color: 'var(--text-muted)' }">{{ ch.word_count }}字</div>
        </div>
        <div v-if="chapters.length === 0" class="text-center py-8 text-sm" :style="{ color: 'var(--text-muted)' }">
          暂无章节
        </div>
      </div>

      <!-- Outlines -->
      <div v-else-if="showOutline" class="flex-1 overflow-y-auto">
        <div class="p-2">
          <button @click="showNewOutlineModal = true" class="w-full flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:bg-brand-50 dark:hover:bg-brand-900/30 rounded-lg">
            + 新建大纲
          </button>
        </div>
        <div v-for="ol in outlines" :key="ol.id" class="px-3 py-2 border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
          <div class="font-medium text-sm" :style="{ color: 'var(--text-primary)' }">{{ ol.title }}</div>
          <div class="text-xs mt-1 whitespace-pre-wrap line-clamp-3" :style="{ color: 'var(--text-secondary)' }">{{ ol.content }}</div>
        </div>
        <div v-if="outlines.length === 0" class="text-center py-8 text-sm" :style="{ color: 'var(--text-muted)' }">
          暂无大纲
        </div>
      </div>

      <!-- Characters -->
      <div v-else class="flex-1 overflow-y-auto">
        <div class="p-2">
          <button @click="showNewCharacterModal = true" class="w-full flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:bg-brand-50 dark:hover:bg-brand-900/30 rounded-lg">
            + 新建角色
          </button>
        </div>
        <div v-for="ch in characters" :key="ch.id" class="px-3 py-2 border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full bg-brand text-white flex items-center justify-center text-xs font-bold">
              {{ ch.name[0] }}
            </div>
            <div>
              <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">{{ ch.name }}</div>
              <div v-if="ch.role" class="text-xs" :style="{ color: 'var(--text-muted)' }">{{ ch.role }}</div>
            </div>
          </div>
          <div v-if="ch.bio" class="text-xs mt-1 ml-8" :style="{ color: 'var(--text-secondary)' }">{{ ch.bio }}</div>
        </div>
        <div v-if="characters.length === 0" class="text-center py-8 text-sm" :style="{ color: 'var(--text-muted)' }">
          暂无角色
        </div>
      </div>

      <!-- Inspirations at bottom -->
      <div class="border-t" :style="{ borderTopColor: 'var(--border-clr)' }">
        <button @click="showNewInspirationModal = true" class="w-full px-3 py-2 text-xs text-brand hover:bg-brand-50 dark:hover:bg-brand-900/30 text-left">
          + 记录灵感
        </button>
        <div v-for="ins in inspirations.slice(0, 3)" :key="ins.id" class="px-3 py-1.5 border-t" :style="{ borderTopColor: 'var(--border-clr)' }">
          <div class="text-xs font-medium" :style="{ color: 'var(--text-primary)' }">{{ ins.title }}</div>
        </div>
      </div>
    </div>

    <!-- Left resize handle -->
    <div
      class="w-1.5 cursor-col-resize hover:bg-brand-200 active:bg-brand-300 dark:hover:bg-brand-700 dark:active:bg-brand-600 shrink-0 relative"
      :style="{ backgroundColor: 'var(--surface-secondary)' }"
      @mousedown.prevent="startDrag($event, 'left')"
    >
      <div class="absolute inset-y-0 left-0 w-px" :style="{ backgroundColor: 'var(--border-clr)' }"></div>
    </div>

    <!-- Editor area -->
    <div class="flex-1 flex flex-col min-w-0" :style="{ backgroundColor: 'var(--surface)' }">
      <!-- Title bar -->
      <div class="h-12 flex items-center px-4 gap-2 border-b" :style="{ borderBottomColor: 'var(--border-clr)' }">
        <input v-model="editorTitle" class="flex-1 text-base font-medium border-none outline-none bg-transparent" :style="{ color: 'var(--text-primary)' }" placeholder="章节标题" />
        <div class="flex items-center gap-2">
          <span class="text-xs" :style="{ color: 'var(--text-muted)' }">{{ editorContent.length }} 字</span>
          <button @click="aiStore.openPanel()" class="btn-secondary text-xs px-2 py-1">
            AI 助手
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto">
        <div v-if="activeChapterId" class="max-w-3xl mx-auto p-6">
          <textarea
            ref="textareaRef"
            v-model="editorContent"
            @select="updateEditorSelection"
            @keyup="updateEditorSelection"
            @mouseup="updateEditorSelection"
            class="w-full min-h-[300px] text-base leading-relaxed border-none outline-none resize-none bg-transparent font-serif overflow-y-auto"
            :style="{ color: 'var(--text-primary)' }"
            placeholder="开始写作..."
          ></textarea>
          <!-- AI Insert Undo Toast -->
          <div v-if="showAiUndo"
            class="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-lg shadow-lg text-sm z-50"
            :style="{ backgroundColor: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border-clr)' }">
            <span>已插入 AI 内容</span>
            <button @click="undoAiInsert"
              class="text-brand font-semibold hover:opacity-80 text-sm">撤销</button>
            <button @click="showAiUndo = false" class="ml-1 opacity-50 hover:opacity-100 text-xs">✕</button>
          </div>
        </div>
        <div v-else class="flex items-center justify-center h-full" :style="{ color: 'var(--text-muted)' }">
          <div class="text-center">
            <p class="mb-2">请选择或创建一个章节</p>
            <button @click="showNewChapterModal = true" class="btn-primary text-sm">新建章节</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Right resize handle -->
    <div
      v-if="aiStore.isPanelOpen"
      class="w-1.5 cursor-col-resize hover:bg-brand-200 active:bg-brand-300 dark:hover:bg-brand-700 dark:active:bg-brand-600 shrink-0 relative"
      :style="{ backgroundColor: 'var(--surface-secondary)' }"
      @mousedown.prevent="startDrag($event, 'right')"
    >
      <div class="absolute inset-y-0 right-0 w-px" :style="{ backgroundColor: 'var(--border-clr)' }"></div>
    </div>

    <!-- AI Panel -->
    <AiPanel
      v-if="aiStore.isPanelOpen"
      :book-id="bookId"
      :chapter-content="editorContent"
      :chapter-id="activeChapterId || undefined"
      :selected-text="aiStore.selectedText"
      :style="{ width: rightPanelWidth + 'px' }"
      @apply-text="applyAiText"
      @replace-text="replaceAiText"
    />

    <!-- Modals -->
    <div v-if="showNewChapterModal" class="modal-overlay" @click.self="showNewChapterModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4" :style="{ color: 'var(--text-primary)' }">新建章节</h3>
        <input v-model="newChapterTitle" type="text" class="form-input" placeholder="章节标题" @keyup.enter="createChapter" />
        <div class="flex justify-end gap-3 mt-4">
          <button @click="showNewChapterModal = false" class="btn-secondary">取消</button>
          <button @click="createChapter" :disabled="!newChapterTitle.trim()" class="btn-primary">创建</button>
        </div>
      </div>
    </div>

    <div v-if="showNewOutlineModal" class="modal-overlay" @click.self="showNewOutlineModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4" :style="{ color: 'var(--text-primary)' }">新建大纲</h3>
        <input v-model="newOutlineTitle" type="text" class="form-input" placeholder="大纲标题" @keyup.enter="createOutline" />
        <div class="flex justify-end gap-3 mt-4">
          <button @click="showNewOutlineModal = false" class="btn-secondary">取消</button>
          <button @click="createOutline" :disabled="!newOutlineTitle.trim()" class="btn-primary">创建</button>
        </div>
      </div>
    </div>

    <div v-if="showNewCharacterModal" class="modal-overlay" @click.self="showNewCharacterModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4" :style="{ color: 'var(--text-primary)' }">新建角色</h3>
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
        <h3 class="text-lg font-semibold mb-4" :style="{ color: 'var(--text-primary)' }">记录灵感</h3>
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
