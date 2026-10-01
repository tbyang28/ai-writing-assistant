import type { Book, Chapter, Comment, Notification, User } from "../db/schema";

export function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

export function toPublicProfile(
  user: User,
  counts: { books: number; followers: number; following: number },
  following = false,
) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar,
    bio: user.bio,
    book_count: counts.books,
    follower_count: counts.followers,
    following_count: counts.following,
    is_following: following,
  };
}

export function toPublicBook(
  book: Book,
  author: User,
  viewer: { liked: boolean; favorited: boolean } = {
    liked: false,
    favorited: false,
  },
) {
  return {
    id: book.id,
    title: book.title,
    cover: book.cover,
    description: book.description,
    status: book.status,
    genre: book.genre,
    tags: parseTags(book.tags),
    word_count: book.wordCount,
    read_count: book.readCount,
    like_count: book.likeCount,
    comment_count: book.commentCount,
    published_at: book.publishedAt,
    allow_comments: book.allowComments,
    author: {
      id: author.id,
      username: author.username,
      name: author.name,
      avatar: author.avatar,
    },
    is_liked: viewer.liked,
    is_favorited: viewer.favorited,
  };
}

export function toPublicChapter(chapter: Chapter, includeContent = false) {
  return {
    id: chapter.id,
    title: chapter.title,
    order: chapter.order,
    word_count: chapter.wordCount,
    status: chapter.status,
    book_id: chapter.bookId,
    ...(includeContent ? { content: chapter.content } : {}),
  };
}

export function toPublicComment(
  comment: Comment,
  author: Pick<User, "id" | "username" | "name" | "avatar">,
) {
  return {
    id: comment.id,
    book_id: comment.bookId,
    chapter_id: comment.chapterId,
    parent_id: comment.parentId,
    content: comment.deletedAt ? "[评论已删除]" : comment.content,
    is_deleted: Boolean(comment.deletedAt),
    is_pinned: comment.isPinned,
    created_at: comment.createdAt,
    author,
  };
}

export function toNotification(
  notification: Notification,
  actor?: Pick<User, "id" | "username" | "name" | "avatar"> | null,
) {
  return {
    id: notification.id,
    type: notification.type,
    book_id: notification.bookId,
    comment_id: notification.commentId,
    read_at: notification.readAt,
    created_at: notification.createdAt,
    actor: actor ?? null,
  };
}
