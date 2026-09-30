import { ref } from 'vue'
import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPost, apiPut } from '@/api'

export interface PublicAuthor { id: string; username: string; name: string; avatar: string | null }
export interface ReadingProgress { chapter_id: string; position: number; updated_at?: string }
export interface PublicBook {
  id: string; title: string; cover: string | null; description: string | null; status: string
  genre: string | null; tags: string[]; word_count: number; read_count: number; like_count: number
  comment_count: number; published_at: string | null; allow_comments: boolean; author: PublicAuthor
  is_liked: boolean; is_favorited: boolean; reading_progress?: ReadingProgress | null
}
export interface PublicChapter { id: string; title: string; order: number; word_count: number; book_id: string; status: string; content?: string }
export interface PublicProfile extends PublicAuthor { bio: string; book_count: number; follower_count: number; following_count: number; is_following: boolean; is_blocked: boolean }
export interface CommunityComment { id: string; book_id: string; chapter_id: string | null; parent_id: string | null; content: string; is_deleted: boolean; is_pinned: boolean; created_at: string; author: PublicAuthor }
export interface CommunityNotification { id: string; type: string; book_id: string | null; comment_id: string | null; chapter_id?: string | null; read_at: string | null; created_at: string; actor: PublicAuthor | null }
export interface Page<T> { items: T[]; page: number; page_size: number; total: number; has_more: boolean }
export interface FeedFilters { sort?: 'latest' | 'popular'; genre?: string; tag?: string; q?: string; page?: number; page_size?: number }
export interface PublicBookDetail { book: PublicBook; chapters: PublicChapter[]; reading_progress?: ReadingProgress | null }
const emptyPage = (): Page<PublicBook> => ({ items: [], page: 1, page_size: 12, total: 0, has_more: false })
export function communityError(error: unknown): string {
  const e = error as { response?: { data?: { message?: string | string[]; detail?: string } }; message?: string }
  const value = e?.response?.data?.message || e?.response?.data?.detail || e?.message
  return Array.isArray(value) ? value.join('；') : value || '操作失败，请稍后重试'
}
function query(filters: FeedFilters) { const params = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)) }); return params.toString() }

export const useCommunityStore = defineStore('community', () => {
  const feed = ref(emptyPage()), favorites = ref(emptyPage())
  const publicBook = ref<PublicBookDetail | null>(null)
  const profile = ref<{ profile: PublicProfile; books: PublicBook[] } | null>(null)
  const notifications = ref<CommunityNotification[]>([])
  const loading = ref<Record<string, boolean>>({})
  const pending = ref<Record<string, boolean>>({})
  const error = ref('')
  let feedRequest = 0, session = 0
  const operations: Record<string, number> = {}
  function $reset() { session++; feedRequest++; feed.value = emptyPage(); favorites.value = emptyPage(); publicBook.value = null; profile.value = null; notifications.value = []; loading.value = {}; pending.value = {}; error.value = '' }
  async function run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const scope = session, ticket = (operations[key] || 0) + 1
    operations[key] = ticket
    loading.value[key] = true; error.value = ''
    try { return await operation() } catch (e) { if (scope === session && operations[key] === ticket) error.value = communityError(e); throw e } finally { if (scope === session && operations[key] === ticket) loading.value[key] = false }
  }
  async function fetchFeed(filters: FeedFilters = {}) {
    const request = ++feedRequest
    return run('feed', async () => { const data = await apiGet<Page<PublicBook>>(`/community/feed?${query(filters)}`); if (request === feedRequest) feed.value = data; return data })
  }
  async function fetchPublicBook(id: string) {
    const scope = session
    return run('book', async () => { const data = await apiGet<PublicBookDetail>(`/community/books/${id}`); if (data.reading_progress !== undefined) data.book.reading_progress = data.reading_progress; if (scope === session) publicBook.value = data; return data })
  }
  async function fetchChapter(id: string) { return apiGet<{ book: { id: string; title: string }; chapter: PublicChapter }>(`/community/chapters/${id}`) }
  async function fetchProfile(id: string) { const scope = session; return run('profile', async () => { const data = await apiGet<{ profile: PublicProfile; books: PublicBook[] }>(`/community/users/${id}`); if (scope === session) profile.value = data; return data }) }
  async function fetchFavorites(page = 1) { const scope = session; return run('favorites', async () => { const data = await apiGet<Page<PublicBook>>(`/community/favorites?page=${page}`); if (scope === session) favorites.value = data; return data }) }
  function bookCopies(id: string) { return [publicBook.value?.book, ...feed.value.items, ...favorites.value.items, ...(profile.value?.books || [])].filter((book): book is PublicBook => !!book && book.id === id) }
  async function toggleBook(book: PublicBook, kind: 'like' | 'favorite') {
    const key = `${kind}:${book.id}`, scope = session
    if (pending.value[key]) return
    const wasActive = kind === 'like' ? book.is_liked : book.is_favorited
    pending.value[key] = true; error.value = ''
    try {
      const url = `/community/books/${book.id}/${kind}`
      const data = await (wasActive ? apiDelete<{ active: boolean; like_count?: number }>(url) : apiPost<{ active: boolean; like_count?: number }>(url))
      if (scope !== session) return
      bookCopies(book.id).forEach(copy => { if (kind === 'like') { copy.like_count = data.like_count ?? Math.max(0, copy.like_count + (data.active === copy.is_liked ? 0 : data.active ? 1 : -1)); copy.is_liked = data.active } else copy.is_favorited = data.active })
    } catch (e) { if (scope === session) error.value = communityError(e); throw e } finally { if (scope === session) pending.value[key] = false }
  }
  async function toggleFollow(author: PublicProfile) { const key = `follow:${author.id}`; if (pending.value[key]) return; const scope = session; pending.value[key] = true; try { const url = `/community/users/${author.id}/follow`; const data = await run(key, () => author.is_following ? apiDelete<{ following: boolean }>(url) : apiPost<{ following: boolean }>(url)); if (scope === session) { author.follower_count = Math.max(0, author.follower_count + (data.following === author.is_following ? 0 : data.following ? 1 : -1)); author.is_following = data.following } } finally { if (scope === session) pending.value[key] = false } }
  async function toggleBlock(author: PublicProfile) { const url = `/community/users/${author.id}/block`; const data = await run('block', () => author.is_blocked ? apiDelete<{ blocked: boolean }>(url) : apiPost<{ blocked: boolean }>(url)); author.is_blocked = data.blocked; return data }
  async function fetchComments(kind: 'books' | 'chapters', id: string) { return apiGet<CommunityComment[]>(`/community/${kind}/${id}/comments`) }
  async function createComment(kind: 'books' | 'chapters', id: string, content: string, parentId?: string) { return apiPost<CommunityComment>(`/community/${kind}/${id}/comments`, { content: content.trim(), ...(parentId ? { parent_id: parentId } : {}) }) }
  async function deleteComment(id: string) { return apiDelete(`/community/comments/${id}`) }
  async function pinComment(comment: CommunityComment) { const url = `/community/comments/${comment.id}/pin`; return comment.is_pinned ? apiDelete(url) : apiPost(url) }
  async function fetchNotifications(page = 1, pageSize = 30) { const scope = session; return run('notifications', async () => { const data = await apiGet<CommunityNotification[]>(`/community/notifications?page=${page}&page_size=${pageSize}`); if (scope === session) notifications.value = data; return data }) }
  async function markNotificationsRead() { const scope = session; await apiPost('/community/notifications/read'); if (scope !== session) return; const now = new Date().toISOString(); notifications.value.forEach(item => { item.read_at ||= now }) }
  async function updateProfile(data: { username: string; bio: string; avatar: string }) { return apiPut<PublicAuthor & { bio: string }>('/community/profile', data) }
  async function publishBook(id: string, data: { visibility: 'PUBLIC' | 'PRIVATE'; genre?: string; tags?: string[]; allow_comments?: boolean; status?: 'SERIAL' | 'FINISHED' }) { return apiPost(`/books/${id}/publish`, data) }
  async function report(target_type: 'BOOK' | 'COMMENT' | 'USER', target_id: string, reason: string) { return apiPost('/community/reports', { target_type, target_id, reason }) }
  async function saveProgress(bookId: string, chapterId: string, position: number) { return apiPost(`/community/books/${bookId}/progress`, { chapter_id: chapterId, position }) }
  return { feed, favorites, publicBook, profile, notifications, loading, pending, error, $reset, fetchFeed, fetchPublicBook, fetchChapter, fetchProfile, fetchFavorites, toggleLike: (book: PublicBook) => toggleBook(book, 'like'), toggleFavorite: (book: PublicBook) => toggleBook(book, 'favorite'), toggleFollow, toggleBlock, fetchComments, createComment, deleteComment, pinComment, fetchNotifications, markNotificationsRead, updateProfile, publishBook, report, saveProgress }
})
