import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPost, apiPut } from '@/api'

export interface Chapter {
  id: string
  title: string
  content: string
  word_count: number
  status: string
  order: number
  book_id: string
  created_at?: string
  updated_at?: string
}

export interface Outline {
  id: string
  title: string
  content?: string
  order: number
}

export interface Character {
  id: string
  name: string
  role?: string
  avatar?: string
  bio?: string
}

export interface CharacterRelation {
  id: string
  source_character_id: string
  target_character_id: string
  relation_type: 'ally' | 'rival' | 'mentor' | 'complex'
  description?: string
  strength: number
  book_id: string
  created_at?: string
  updated_at?: string
}

export interface Inspiration {
  id: string
  title: string
  content: string
  tags: string
  created_at?: string
}

export interface Book {
  id: string
  title: string
  cover?: string
  description?: string
  status: string
  word_count: number
  owner_id: string
  created_at?: string
  updated_at?: string
  chapters?: Chapter[]
  outlines?: Outline[]
  characters?: Character[]
  character_relations?: CharacterRelation[]
  inspirations?: Inspiration[]
}

export interface BookStats {
  totalBooks: number
  totalWords: number
  totalChapters: number
  serialBooks: number
  finishedBooks: number
}

export const useBookStore = defineStore('book', () => {
  const books = ref<Book[]>([])
  const currentBook = ref<Book | null>(null)
  const isLoading = ref(false)
  const stats = ref<BookStats | null>(null)
  const writingStats = ref<any>(null)

  const currentChapter = ref<Chapter | null>(null)

  async function fetchBooks() {
    isLoading.value = true
    try {
      const data: any = await apiGet('/books')
      books.value = data.data || data || []
      return books.value
    } finally {
      isLoading.value = false
    }
  }

  async function fetchBook(id: string) {
    isLoading.value = true
    try {
      const data: any = await apiGet(`/books/${id}`)
      currentBook.value = data.data || data
      return currentBook.value
    } finally {
      isLoading.value = false
    }
  }

  async function createBook(data: { title: string; description?: string; cover?: string }) {
    const res: any = await apiPost('/books', data)
    const book = res.data || res
    books.value.unshift(book)
    return book
  }

  async function seedDemoBook() {
    const res: any = await apiPost('/demo/seed')
    const book = res.data || res
    currentBook.value = book
    await Promise.all([fetchBooks(), fetchStats(), fetchWritingStats()])
    return book
  }

  async function updateBook(id: string, data: { title?: string; description?: string; cover?: string; status?: string }) {
    const res: any = await apiPut(`/books/${id}`, data)
    const updated = res.data || res
    const idx = books.value.findIndex((b) => b.id === id)
    if (idx >= 0) books.value[idx] = { ...books.value[idx], ...updated }
    if (currentBook.value?.id === id) currentBook.value = { ...currentBook.value, ...updated }
    return updated
  }

  async function deleteBook(id: string) {
    await apiDelete(`/books/${id}`)
    books.value = books.value.filter((b) => b.id !== id)
    if (currentBook.value?.id === id) currentBook.value = null
  }

  async function fetchStats() {
    try {
      const data: any = await apiGet('/books/stats')
      stats.value = data.data || data
    } catch (e) { /* ignore */ }
    return stats.value
  }

  async function fetchWritingStats(days = 7) {
    try {
      const data: any = await apiGet(`/stats?days=${days}`)
      writingStats.value = data.data || data
    } catch (e) { /* ignore */ }
    return writingStats.value
  }

  async function createChapter(bookId: string, data: { title?: string }) {
    const res: any = await apiPost(`/books/${bookId}/chapters`, data)
    const chapter = res.data || res
    if (currentBook.value?.id === bookId) await fetchBook(bookId)
    return chapter
  }

  async function fetchChapter(chapterId: string) {
    const data: any = await apiGet(`/chapters/${chapterId}`)
    const chapter = data.data || data
    currentChapter.value = chapter
    return chapter
  }

  async function saveChapter(chapterId: string, data: { title?: string; content?: string }) {
    const res: any = await apiPut('/chapters/save', { chapter_id: chapterId, ...data })
    const updated = res.data || res
    if (currentBook.value) {
      const chs = currentBook.value.chapters || []
      const idx = chs.findIndex((c) => c.id === chapterId)
      if (idx >= 0) chs[idx] = { ...chs[idx], ...updated }
    }
    currentChapter.value = updated
    return updated
  }

  async function deleteChapter(chapterId: string) {
    if (!currentBook.value) return
    await apiDelete(`/books/${currentBook.value.id}/chapters/${chapterId}`)
    await fetchBook(currentBook.value.id)
  }

  async function publishChapter(chapterId: string) {
    const res: any = await apiPost('/chapters/publish', { chapter_id: chapterId })
    const updated = res.data || res
    if (currentBook.value) await fetchBook(currentBook.value.id)
    return updated
  }

  async function createOutline(bookId: string, data: { title: string; content?: string }) {
    const res: any = await apiPost(`/books/${bookId}/outlines`, data)
    if (currentBook.value?.id === bookId) await fetchBook(bookId)
    return res.data || res
  }

  async function createCharacter(bookId: string, data: { name: string; role?: string; bio?: string }) {
    const res: any = await apiPost(`/books/${bookId}/characters`, data)
    if (currentBook.value?.id === bookId) await fetchBook(bookId)
    return res.data || res
  }

  async function createCharacterRelation(bookId: string, data: {
    source_character_id: string
    target_character_id: string
    relation_type: CharacterRelation['relation_type']
    description?: string
    strength?: number
  }) {
    const res: any = await apiPost(`/books/${bookId}/character-relations`, data)
    if (currentBook.value?.id === bookId) await fetchBook(bookId)
    return res.data || res
  }

  async function deleteCharacterRelation(bookId: string, relationId: string) {
    await apiDelete(`/books/${bookId}/character-relations/${relationId}`)
    if (currentBook.value?.id === bookId) await fetchBook(bookId)
  }

  async function createInspiration(bookId: string, data: { title: string; content: string; tags?: string[] }) {
    const res: any = await apiPost(`/books/${bookId}/inspirations`, data)
    if (currentBook.value?.id === bookId) await fetchBook(bookId)
    return res.data || res
  }

  return {
    books, currentBook, isLoading, stats, writingStats, currentChapter,
    fetchBooks, fetchBook, createBook, seedDemoBook, updateBook, deleteBook,
    fetchStats, fetchWritingStats,
    createChapter, fetchChapter, saveChapter, deleteChapter, publishChapter,
    createOutline, createCharacter, createCharacterRelation, deleteCharacterRelation, createInspiration,
  }
})
