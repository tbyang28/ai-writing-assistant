import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCommunityStore } from './community'
import { apiGet, apiPost, apiDelete } from '@/api'

vi.mock('@/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiPut: vi.fn(), api: { defaults: { headers: { common: {} } } } }))
const book = { id: 'book-1', title: '雨巷', cover: null, description: '故事', status: 'SERIAL', genre: '都市', tags: ['悬疑'], word_count: 800, read_count: 2, like_count: 3, comment_count: 0, published_at: null, allow_comments: true, author: { id: 'author-1', username: 'writer', name: '作者', avatar: null }, is_liked: false, is_favorited: false }
const feed = { items: [book], page: 2, page_size: 12, total: 13, has_more: false }

beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks() })
describe('community reader state', () => {
  it('loads paginated filtered feed with encoded search values', async () => {
    vi.mocked(apiGet).mockResolvedValue(feed)
    const store = useCommunityStore()
    await store.fetchFeed({ sort: 'popular', genre: '都市', tag: 'a&b', q: '雨 巷', page: 2 })
    expect(store.feed.items[0]?.title).toBe('雨巷')
    expect(store.feed.total).toBe(13)
    const url = vi.mocked(apiGet).mock.calls[0][0]
    expect(new URLSearchParams(url.split('?')[1]).get('tag')).toBe('a&b')
    expect(new URLSearchParams(url.split('?')[1]).get('q')).toBe('雨 巷')
    expect(store.loading.feed).toBe(false)
  })
  it('does not let an older feed response replace a newer filter', async () => {
    let finish!: (v: unknown) => void
    vi.mocked(apiGet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ ...feed, items: [{ ...book, id: 'new' }] })
    const store = useCommunityStore()
    const first = store.fetchFeed({ q: 'old' })
    await store.fetchFeed({ q: 'new' })
    finish(feed); await first
    expect(store.feed.items[0]?.id).toBe('new')
  })
  it('changes like state only after success and synchronizes cards and detail', async () => {
    const store = useCommunityStore()
    store.feed = structuredClone(feed); store.publicBook = { book: structuredClone(book), chapters: [] }
    let finish!: (v: unknown) => void
    vi.mocked(apiPost).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const request = store.toggleLike(book)
    expect(store.publicBook.book.is_liked).toBe(false)
    expect(store.pending['like:book-1']).toBe(true)
    await store.toggleLike(book)
    expect(apiPost).toHaveBeenCalledTimes(1)
    finish({ active: true }); await request
    expect(store.publicBook.book.is_liked).toBe(true)
    expect(store.feed.items[0]?.like_count).toBe(4)
    expect(store.pending['like:book-1']).toBe(false)
  })
  it('preserves favorite on failed removal and exposes a useful error', async () => {
    const store = useCommunityStore()
    store.publicBook = { book: { ...book, is_favorited: true }, chapters: [] }
    vi.mocked(apiDelete).mockRejectedValue({ response: { data: { message: '作品不可见' } } })
    await expect(store.toggleFavorite(store.publicBook.book)).rejects.toBeDefined()
    expect(store.publicBook.book.is_favorited).toBe(true)
    expect(store.error).toBe('作品不可见')
    expect(store.pending['favorite:book-1']).toBe(false)
  })
  it('keeps reply association when posting to a chapter discussion', async () => {
    const store = useCommunityStore()
    vi.mocked(apiPost).mockResolvedValue({ id: 'reply', parent_id: 'parent', content: '回复' })
    await store.createComment('chapters', 'chapter-1', '回复', 'parent')
    expect(apiPost).toHaveBeenCalledWith('/community/chapters/chapter-1/comments', { content: '回复', parent_id: 'parent' })
  })
})

 it('clears the previous account social state on login and logout', async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  const { useAuthStore } = await import('./auth')
  const store = useCommunityStore(); const auth = useAuthStore()
  store.favorites = structuredClone(feed)
  auth.setAuth('new-token', { id: 'new-user', name: '新用户', email: 'new@example.com', avatar: '' })
  expect(store.favorites.items).toEqual([])
  store.profile = { profile: { id: 'old-user' }, books: [] } as any
  auth.logout()
  expect(store.profile).toBeNull()
  vi.unstubAllGlobals()
})
 it('discards an in-flight private response after account reset', async () => {
  let finish!: (v: unknown) => void
  vi.mocked(apiGet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const store = useCommunityStore(); const request = store.fetchFavorites()
  store.$reset(); finish(feed); await request
  expect(store.favorites.items).toEqual([])
})
it('keeps new account notifications unread when an old mark-read response completes', async () => {
  let finish!: (v: unknown) => void
  vi.mocked(apiPost).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const store = useCommunityStore(); const old = store.markNotificationsRead()
  store.$reset()
  store.notifications = [{ id: 'new', type: 'FOLLOW', book_id: null, comment_id: null, read_at: null, created_at: '2026-09-30', actor: null }]
  finish({ read: true }); await old
  expect(store.notifications[0]?.read_at).toBeNull()
})
it('keeps loading active while the newer feed request is still pending', async () => {
  let first!: (v: unknown) => void, second!: (v: unknown) => void
  vi.mocked(apiGet).mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockImplementationOnce(() => new Promise(resolve => { second = resolve }))
  const store = useCommunityStore(); const older = store.fetchFeed({ q: 'old' }); const newer = store.fetchFeed({ q: 'new' })
  first(feed); await older
  expect(store.loading.feed).toBe(true)
  second(feed); await newer
  expect(store.loading.feed).toBe(false)
})
