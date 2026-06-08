<script setup lang="ts">
import { onMounted, ref, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBookStore, type Chapter, type Outline, type Character } from '@/stores/book'
import { useAiStore } from '@/stores/ai'
import AiPanel from '@/components/AiPanel.vue'
import CharacterGraph from '@/components/CharacterGraph.vue'

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
const workspaceMode = ref<'editor' | 'graph'>('editor')

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
const creatingChapter = ref(false)
const showNewOutlineModal = ref(false)
const newOutlineTitle = ref('')
const showNewCharacterModal = ref(false)
const newCharacterName = ref('')
const newCharacterRole = ref('')
const showExtractCharactersModal = ref(false)
const extractedCharacters = ref<Array<{ name: string; role: string; bio: string; confidence: number; selected: boolean }>>([])
const showNewRelationModal = ref(false)
const newRelationSource = ref('')
const newRelationTarget = ref('')
const newRelationType = ref<'ally' | 'rival' | 'mentor' | 'complex'>('ally')
const newRelationStrength = ref(2)
const newRelationDescription = ref('')
const showNewInspirationModal = ref(false)
const newInspirationTitle = ref('')
const newInspirationContent = ref('')
const selectionStart = ref(0)
const selectionEnd = ref(0)
const contentAreaRef = ref<HTMLDivElement | null>(null)

onMounted(async () => {
  if (!bookId.value || bookId.value === 'undefined' || bookId.value === 'null') {
    router.replace('/')
    return
  }

  await bookStore.fetchBook(bookId.value)
  const chapters = bookStore.currentBook?.chapters || []
  if (chapters.length > 0) {
    activeChapterId.value = chapters[0].id
    await loadChapter(chapters[0].id)
  }
})

const chapters = computed(() => bookStore.currentBook?.chapters || [])
const outlines = computed(() => bookStore.currentBook?.outlines || [])
const characters = computed(() => bookStore.currentBook?.characters || [])
const characterRelations = computed(() => bookStore.currentBook?.character_relations || [])
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

async function openNewChapter() {
  newChapterTitle.value = ''
  showNewChapterModal.value = true
}

async function confirmNewChapter() {
  if (creatingChapter.value) return
  creatingChapter.value = true
  try {
    const title = newChapterTitle.value.trim()
    const chapter = await bookStore.createChapter(bookId.value, title ? { title } : {})
    showNewChapterModal.value = false
    newChapterTitle.value = ''
    if (chapter?.id) {
      await loadChapter(chapter.id)
    }
  } finally {
    creatingChapter.value = false
  }
}

function cancelNewChapter() {
  showNewChapterModal.value = false
  newChapterTitle.value = ''
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

async function extractCharactersFromChapter() {
  if (!editorContent.value.trim() || aiStore.isLoading) return
  const existingNames = new Set(characters.value.map((character) => character.name))
  const suggestions = await aiStore.extractCharacters(
    bookId.value,
    editorContent.value,
    activeChapterId.value || undefined,
  )
  extractedCharacters.value = suggestions
    .filter((item) => item.name && !existingNames.has(item.name))
    .map((item) => ({ ...item, selected: true }))
  showExtractCharactersModal.value = true
}

async function saveExtractedCharacters() {
  const selected = extractedCharacters.value.filter((item) => item.selected)
  for (const item of selected) {
    await bookStore.createCharacter(bookId.value, {
      name: item.name,
      role: item.role,
      bio: item.bio,
    })
  }
  showExtractCharactersModal.value = false
  extractedCharacters.value = []
  showCharacters.value = true
  showOutline.value = false
  switchWorkspaceMode('graph')
}

async function createRelation() {
  if (!newRelationSource.value || !newRelationTarget.value || newRelationSource.value === newRelationTarget.value) return
  await bookStore.createCharacterRelation(bookId.value, {
    source_character_id: newRelationSource.value,
    target_character_id: newRelationTarget.value,
    relation_type: newRelationType.value,
    description: newRelationDescription.value || undefined,
    strength: newRelationStrength.value,
  })
  newRelationSource.value = ''
  newRelationTarget.value = ''
  newRelationType.value = 'ally'
  newRelationStrength.value = 2
  newRelationDescription.value = ''
  showNewRelationModal.value = false
  showCharacters.value = true
  showOutline.value = false
  switchWorkspaceMode('graph')
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

function switchWorkspaceMode(mode: 'editor' | 'graph') {
  workspaceMode.value = mode
  if (mode === 'graph') {
    showCharacters.value = true
    showOutline.value = false
  }

  nextTick(() => {
    if (contentAreaRef.value) contentAreaRef.value.scrollTop = 0
    if (mode === 'editor') autoResizeTextarea()
  })
}

watch(workspaceMode, (mode) => {
  if (mode === 'editor') {
    nextTick(autoResizeTextarea)
  }
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
          <button @click="openNewChapter" :disabled="creatingChapter" class="w-full flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:bg-brand-50 dark:hover:bg-brand-900/30 rounded-lg">
            + 新建章节
          </button>
        </div>
        <div v-for="ch in chapters" :key="ch.id"
          @click="selectChapter(ch.id)"
          class="px-3 py-2 cursor-pointer text-sm border-b border-l-4 transition-colors"
          :class="activeChapterId === ch.id
            ? 'border-l-brand bg-brand-50/80 dark:bg-brand-900/30 hover:bg-brand-50 dark:hover:bg-brand-900/40'
            : 'border-l-transparent hover:bg-gray-50 dark:hover:bg-gray-800'"
          :style="{ borderBottomColor: 'var(--border-clr)' }">
          <div class="font-medium truncate"
            :class="activeChapterId === ch.id ? 'text-brand dark:text-white' : ''"
            :style="activeChapterId === ch.id ? {} : { color: 'var(--text-primary)' }">
            {{ ch.title }}
          </div>
          <div class="text-xs mt-0.5"
            :class="activeChapterId === ch.id ? 'text-brand-600 dark:text-brand-300' : ''"
            :style="activeChapterId === ch.id ? {} : { color: 'var(--text-muted)' }">
            {{ ch.word_count }}字
          </div>
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
          <button @click="extractCharactersFromChapter"
            :disabled="!editorContent.trim() || aiStore.isLoading"
            class="mt-1 w-full flex items-center justify-between gap-2 px-2 py-1.5 text-xs rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-40 disabled:cursor-not-allowed dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-900/50">
            <span>{{ aiStore.isLoading ? '识别中...' : 'AI 识别人物' }}</span>
            <span>当前章</span>
          </button>
          <button @click="showNewRelationModal = true"
            :disabled="characters.length < 2"
            class="mt-1 w-full flex items-center gap-1 px-2 py-1.5 text-xs text-brand hover:bg-brand-50 dark:hover:bg-brand-900/30 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
            + 新建关系
          </button>
          <button @click="switchWorkspaceMode('graph')"
            class="mt-1 w-full flex items-center justify-between gap-2 px-2 py-1.5 text-xs rounded-lg border transition-colors"
            :class="workspaceMode === 'graph' ? 'text-cyan-600 border-cyan-300 bg-cyan-50 dark:text-cyan-300 dark:border-cyan-800 dark:bg-cyan-950/40' : 'text-gray-500 border-transparent hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800'">
            <span>打开关系图</span>
            <span>{{ characters.length }}人</span>
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
        <input v-if="workspaceMode === 'editor'" v-model="editorTitle" class="flex-1 text-base font-medium border-none outline-none bg-transparent" :style="{ color: 'var(--text-primary)' }" placeholder="章节标题" />
        <div v-else class="flex-1 text-base font-medium" :style="{ color: 'var(--text-primary)' }">
          角色关系图
        </div>
        <div class="flex items-center gap-2">
          <button @click="switchWorkspaceMode('editor')"
            class="text-xs px-2 py-1 rounded-lg"
            :class="workspaceMode === 'editor' ? 'bg-brand text-white' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'">
            编辑器
          </button>
          <button @click="switchWorkspaceMode('graph')"
            class="text-xs px-2 py-1 rounded-lg"
            :class="workspaceMode === 'graph' ? 'bg-brand text-white' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'">
            关系图
          </button>
          <span v-if="workspaceMode === 'editor'" class="text-xs" :style="{ color: 'var(--text-muted)' }">{{ editorContent.length }} 字</span>
          <button @click="aiStore.openPanel()" class="btn-secondary text-xs px-2 py-1">
            AI 助手
          </button>
        </div>
      </div>

      <!-- Content -->
      <div ref="contentAreaRef" class="flex-1 overflow-auto">
        <CharacterGraph
          v-if="workspaceMode === 'graph'"
          :characters="characters"
          :relations="characterRelations"
          :book-title="bookStore.currentBook?.title"
        />
        <div v-else-if="activeChapterId" class="max-w-3xl mx-auto p-6">
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
            <button @click="openNewChapter" :disabled="creatingChapter" class="btn-primary text-sm">新建章节</button>
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
    <div v-if="showNewChapterModal" class="modal-overlay" @click.self="cancelNewChapter">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4" :style="{ color: 'var(--text-primary)' }">新建章节</h3>
        <input v-model="newChapterTitle" type="text" class="form-input" placeholder="章节标题" @keyup.enter="confirmNewChapter" />
        <div class="flex justify-end gap-3 mt-4">
          <button @click="cancelNewChapter" class="btn-secondary">取消</button>
          <button @click="confirmNewChapter" :disabled="creatingChapter" class="btn-primary">
            {{ creatingChapter ? '创建中...' : '确定' }}
          </button>
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

    <div v-if="showExtractCharactersModal" class="modal-overlay" @click.self="showExtractCharactersModal = false">
      <div class="modal-content max-w-2xl">
        <div class="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 class="text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">AI 识别到的人物</h3>
            <p class="text-sm mt-1" :style="{ color: 'var(--text-muted)' }">确认后保存到角色库，避免误识别的内容可以取消勾选。</p>
          </div>
          <span class="text-xs px-2 py-1 rounded-full bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
            {{ extractedCharacters.filter((item) => item.selected).length }} 个待保存
          </span>
        </div>

        <div v-if="extractedCharacters.length" class="space-y-2 max-h-96 overflow-y-auto">
          <label
            v-for="character in extractedCharacters"
            :key="character.name"
            class="flex gap-3 rounded-lg border p-3 cursor-pointer"
            :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }"
          >
            <input v-model="character.selected" type="checkbox" class="mt-1 accent-violet-600" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-3">
                <div class="font-medium" :style="{ color: 'var(--text-primary)' }">{{ character.name }}</div>
                <div class="text-xs" :style="{ color: 'var(--text-muted)' }">
                  置信度 {{ Math.round(character.confidence * 100) }}%
                </div>
              </div>
              <div class="text-xs mt-1 text-violet-600 dark:text-violet-300">{{ character.role || '未知' }}</div>
              <p class="text-sm mt-2 leading-6" :style="{ color: 'var(--text-secondary)' }">{{ character.bio }}</p>
            </div>
          </label>
        </div>

        <div v-else class="rounded-lg border p-6 text-center" :style="{ borderColor: 'var(--border-clr)', color: 'var(--text-muted)' }">
          没有识别到新的角色。可能是章节内容太短，或人物已经存在于角色库。
        </div>

        <div v-if="aiStore.error" class="mt-3 text-sm text-red-500">
          {{ aiStore.error }}
        </div>

        <div class="flex justify-end gap-3 mt-4">
          <button @click="showExtractCharactersModal = false" class="btn-secondary">取消</button>
          <button @click="saveExtractedCharacters" :disabled="!extractedCharacters.some((item) => item.selected)" class="btn-primary">
            保存选中人物
          </button>
        </div>
      </div>
    </div>

    <div v-if="showNewRelationModal" class="modal-overlay" @click.self="showNewRelationModal = false">
      <div class="modal-content">
        <h3 class="text-lg font-semibold mb-4" :style="{ color: 'var(--text-primary)' }">新建人物关系</h3>
        <div class="space-y-3">
          <select v-model="newRelationSource" class="form-input">
            <option value="">选择起点角色</option>
            <option v-for="character in characters" :key="character.id" :value="character.id">
              {{ character.name }}
            </option>
          </select>
          <select v-model="newRelationTarget" class="form-input">
            <option value="">选择目标角色</option>
            <option v-for="character in characters" :key="character.id" :value="character.id" :disabled="character.id === newRelationSource">
              {{ character.name }}
            </option>
          </select>
          <select v-model="newRelationType" class="form-input">
            <option value="ally">同盟</option>
            <option value="rival">敌对</option>
            <option value="mentor">引导 / 师徒</option>
            <option value="complex">复杂 / 暧昧</option>
          </select>
          <label class="form-label">
            关系强度：{{ newRelationStrength }}
          </label>
          <input v-model.number="newRelationStrength" type="range" min="1" max="5" class="w-full accent-cyan-500" />
          <textarea v-model="newRelationDescription" rows="3" class="form-textarea" placeholder="关系说明，例如：共同调查宗门旧案，彼此信任但隐藏秘密。" />
        </div>
        <div class="flex justify-end gap-3 mt-4">
          <button @click="showNewRelationModal = false" class="btn-secondary">取消</button>
          <button @click="createRelation" :disabled="!newRelationSource || !newRelationTarget || newRelationSource === newRelationTarget" class="btn-primary">
            创建关系
          </button>
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
