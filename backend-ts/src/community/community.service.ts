import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { DRIZZLE, type Database } from "../db/drizzle.module";
import {
  blocks,
  bookFavorites,
  bookLikes,
  books,
  chapters,
  comments,
  follows,
  notifications,
  readingProgress,
  reports,
  users,
  type Book,
  type User,
} from "../db/schema";
import {
  toNotification,
  toPublicBook,
  toPublicChapter,
  toPublicComment,
  toPublicProfile,
} from "./mappers";
import { parseTags } from "./mappers";
import { toBookListPayload } from "../books/mappers";
import type { CommentInput, FeedQuery, PublishInput } from "./dto";
type Executor = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "execute"
>;

@Injectable()
export class CommunityService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private visibleAuthor(
    author:
      | SQL
      | typeof books.ownerId
      | typeof comments.authorId
      | typeof users.id,
    viewerId?: string,
  ) {
    return viewerId
      ? sql`not exists (select 1 from blocks b where (b.blocker_id = ${viewerId} and b.blocked_id = ${author}) or (b.blocked_id = ${viewerId} and b.blocker_id = ${author}))`
      : sql`true`;
  }
  private async blocked(a: string, b: string, db: Executor = this.db) {
    if (a === b) return false;
    const rows = await db
      .select()
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
          and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  private async user(id: string, db: Executor = this.db) {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("用户不存在");
    return row;
  }
  private async pairLock(db: Executor, a: string, b: string) {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${[a, b].sort().join(":")}, 0))`,
    );
  }
  private async publicBook(id: string, viewerId?: string) {
    const [row] = await this.db
      .select({ book: books, author: users })
      .from(books)
      .innerJoin(users, eq(books.ownerId, users.id))
      .where(
        and(
          eq(books.id, id),
          eq(books.visibility, "PUBLIC"),
          this.visibleAuthor(books.ownerId, viewerId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("公开作品不存在");
    return row;
  }
  private async flags(bookId: string, viewerId?: string) {
    if (!viewerId) return { liked: false, favorited: false };
    const [likes, favorites] = await Promise.all([
      this.db
        .select()
        .from(bookLikes)
        .where(
          and(eq(bookLikes.userId, viewerId), eq(bookLikes.bookId, bookId)),
        )
        .limit(1),
      this.db
        .select()
        .from(bookFavorites)
        .where(
          and(
            eq(bookFavorites.userId, viewerId),
            eq(bookFavorites.bookId, bookId),
          ),
        )
        .limit(1),
    ]);
    return { liked: likes.length > 0, favorited: favorites.length > 0 };
  }
  private async progress(bookId: string, viewerId?: string) {
    if (!viewerId) return null;
    const [row] = await this.db
      .select({
        chapter_id: readingProgress.chapterId,
        position: readingProgress.position,
        updated_at: readingProgress.updatedAt,
      })
      .from(readingProgress)
      .innerJoin(chapters, eq(readingProgress.chapterId, chapters.id))
      .where(
        and(
          eq(readingProgress.bookId, bookId),
          eq(readingProgress.userId, viewerId),
          eq(chapters.status, "PUBLISHED"),
        ),
      )
      .limit(1);
    return row ?? null;
  }
  private publicCommentsCondition(bookId: string) {
    return and(
      eq(comments.bookId, bookId),
      isNull(comments.deletedAt),
      sql`(${comments.chapterId} is null or exists (select 1 from chapters c where c.id = ${comments.chapterId} and c.status = 'PUBLISHED'))`,
    );
  }
  private async card(book: Book, author: User, viewerId?: string) {
    const [words, commentCount, flags, progress] = await Promise.all([
      this.db
        .select({ n: sql<number>`coalesce(sum(${chapters.wordCount}),0)` })
        .from(chapters)
        .where(
          and(eq(chapters.bookId, book.id), eq(chapters.status, "PUBLISHED")),
        ),
      this.db
        .select({ n: count() })
        .from(comments)
        .where(
          and(
            this.publicCommentsCondition(book.id),
            this.visibleAuthor(comments.authorId, viewerId),
          ),
        ),
      this.flags(book.id, viewerId),
      this.progress(book.id, viewerId),
    ]);
    return {
      ...toPublicBook(
        {
          ...book,
          wordCount: Number(words[0]?.n ?? 0),
          commentCount: Number(commentCount[0]?.n ?? 0),
        },
        author,
        flags,
      ),
      reading_progress: progress,
    };
  }
  private page<T>(items: T[], total: number, query: FeedQuery) {
    return {
      items,
      total,
      page: query.page,
      page_size: query.page_size,
      has_more: query.page * query.page_size < total,
    };
  }
  async listFeed(query: FeedQuery, viewerId?: string) {
    const filters = [
      eq(books.visibility, "PUBLIC"),
      this.visibleAuthor(books.ownerId, viewerId),
    ];
    if (query.genre) filters.push(eq(books.genre, query.genre));
    if (query.tag) filters.push(sql`${books.tags}::jsonb ? ${query.tag}`);
    if (query.q)
      filters.push(
        or(
          ilike(books.title, `%${query.q}%`),
          ilike(books.description, `%${query.q}%`),
        )!,
      );
    const [rows, total] = await Promise.all([
      this.db
        .select({ book: books, author: users })
        .from(books)
        .innerJoin(users, eq(books.ownerId, users.id))
        .where(and(...filters))
        .orderBy(
          query.sort === "popular"
            ? desc(books.likeCount)
            : desc(books.publishedAt),
          desc(books.id),
        )
        .limit(query.page_size)
        .offset((query.page - 1) * query.page_size),
      this.db
        .select({ n: count() })
        .from(books)
        .where(and(...filters)),
    ]);
    return this.page(
      await Promise.all(rows.map((r) => this.card(r.book, r.author, viewerId))),
      Number(total[0]?.n ?? 0),
      query,
    );
  }
  async search(
    query: FeedQuery & { type: "books" | "users"; q: string },
    viewerId?: string,
  ) {
    if (query.type === "books") return this.listFeed(query, viewerId);
    const filter = and(
      or(
        ilike(users.name, `%${query.q}%`),
        ilike(users.username, `%${query.q}%`),
      ),
      this.visibleAuthor(users.id, viewerId),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(users)
        .where(filter)
        .orderBy(asc(users.username))
        .limit(query.page_size)
        .offset((query.page - 1) * query.page_size),
      this.db.select({ n: count() }).from(users).where(filter),
    ]);
    const items = await Promise.all(
      rows.map(
        async (user) => (await this.getProfile(user.id, viewerId)).profile,
      ),
    );
    return this.page(items, Number(total[0]?.n ?? 0), query);
  }
  async listChapters(bookId: string, viewerId?: string) {
    await this.publicBook(bookId, viewerId);
    const rows = await this.db
      .select()
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.status, "PUBLISHED")))
      .orderBy(asc(chapters.order), asc(chapters.id));
    return rows.map((chapter) => toPublicChapter(chapter));
  }
  async getPublicBook(bookId: string, viewerId?: string) {
    const row = await this.publicBook(bookId, viewerId);
    const [book, chapterRows, progress] = await Promise.all([
      this.card(row.book, row.author, viewerId),
      this.listChapters(bookId, viewerId),
      this.progress(bookId, viewerId),
    ]);
    return { book, chapters: chapterRows, reading_progress: progress };
  }
  async getPublicChapter(chapterId: string, viewerId?: string) {
    const [row] = await this.db
      .select({ chapter: chapters, book: books })
      .from(chapters)
      .innerJoin(books, eq(chapters.bookId, books.id))
      .where(
        and(
          eq(chapters.id, chapterId),
          eq(chapters.status, "PUBLISHED"),
          eq(books.visibility, "PUBLIC"),
          this.visibleAuthor(books.ownerId, viewerId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("公开章节不存在");
    await this.db
      .update(books)
      .set({ readCount: sql`${books.readCount}+1` })
      .where(eq(books.id, row.book.id));
    return {
      book: { id: row.book.id, title: row.book.title },
      chapter: toPublicChapter(row.chapter, true),
    };
  }
  async getProfile(id: string, viewerId?: string) {
    const author = await this.user(id);
    const hidden = viewerId ? await this.blocked(id, viewerId) : false;
    const [published, followers, following, relation, ownBlock] =
      await Promise.all([
        this.db
          .select()
          .from(books)
          .where(and(eq(books.ownerId, id), eq(books.visibility, "PUBLIC")))
          .orderBy(desc(books.publishedAt)),
        this.db
          .select({ n: count() })
          .from(follows)
          .where(eq(follows.followingId, id)),
        this.db
          .select({ n: count() })
          .from(follows)
          .where(eq(follows.followerId, id)),
        viewerId
          ? this.db
              .select()
              .from(follows)
              .where(
                and(
                  eq(follows.followerId, viewerId),
                  eq(follows.followingId, id),
                ),
              )
          : [],
        viewerId
          ? this.db
              .select()
              .from(blocks)
              .where(
                and(eq(blocks.blockerId, viewerId), eq(blocks.blockedId, id)),
              )
          : [],
      ]);
    return {
      profile: {
        ...toPublicProfile(
          author,
          {
            books: hidden ? 0 : published.length,
            followers: Number(followers[0].n),
            following: Number(following[0].n),
          },
          relation.length > 0,
        ),
        is_blocked: ownBlock.length > 0,
      },
      books: hidden
        ? []
        : await Promise.all(
            published.map((book) => this.card(book, author, viewerId)),
          ),
    };
  }
  async updateProfile(
    id: string,
    input: { username: string; bio: string; avatar?: string },
  ) {
    try {
      const [user] = await this.db
        .update(users)
        .set({
          username: input.username,
          bio: input.bio,
          ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
        })
        .where(eq(users.id, id))
        .returning();
      if (!user) throw new NotFoundException("用户不存在");
      return (await this.getProfile(id, id)).profile;
    } catch (error: any) {
      if (error.code === "23505" || error.cause?.code === "23505")
        throw new BadRequestException("用户名已被使用");
      throw error;
    }
  }
  async publishBook(id: string, ownerId: string, input: PublishInput) {
    return this.db.transaction(async (tx) => {
      const [book] = await tx
        .select()
        .from(books)
        .where(and(eq(books.id, id), eq(books.ownerId, ownerId)))
        .for("update");
      if (!book) throw new NotFoundException("作品不存在");
      const [updated] = await tx
        .update(books)
        .set({
          visibility: input.visibility,
          status:
            input.status ??
            (input.visibility === "PUBLIC" && book.status === "DRAFT"
              ? "SERIAL"
              : book.status),
          genre: input.genre ?? book.genre,
          tags: input.tags
            ? JSON.stringify([...new Set(input.tags)])
            : book.tags,
          allowComments: input.allow_comments ?? book.allowComments,
          publishedAt:
            input.visibility === "PUBLIC"
              ? (book.publishedAt ?? new Date())
              : book.publishedAt,
          updatedAt: new Date(),
        })
        .where(eq(books.id, id))
        .returning();
      return toBookListPayload(updated);
    });
  }
  private async withPublicBook<T>(
    id: string,
    actor: string,
    action: (db: Executor, book: Book) => Promise<T>,
  ) {
    const { book } = await this.publicBook(id);
    return this.db.transaction(async (tx) => {
      await this.pairLock(tx, actor, book.ownerId);
      const [current] = await tx
        .select()
        .from(books)
        .where(and(eq(books.id, id), eq(books.visibility, "PUBLIC")))
        .for("update");
      if (!current) throw new NotFoundException("公开作品不存在");
      if (await this.blocked(actor, current.ownerId, tx))
        throw new ForbiddenException("无法与已屏蔽的用户互动");
      return action(tx, current);
    });
  }
  private async notify(
    db: Executor,
    recipientId: string,
    actorId: string,
    type: string,
    bookId: string | null = null,
    commentId: string | null = null,
  ) {
    if (
      recipientId === actorId ||
      (await this.blocked(recipientId, actorId, db))
    )
      return;
    await db
      .insert(notifications)
      .values({ recipientId, actorId, type, bookId, commentId });
  }
  async toggleBook(
    id: string,
    actor: string,
    kind: "like" | "favorite",
    active: boolean,
  ) {
    return this.withPublicBook(id, actor, async (db, book) => {
      const table = kind === "like" ? bookLikes : bookFavorites;
      if (active) {
        const added = await db
          .insert(table)
          .values({ userId: actor, bookId: id })
          .onConflictDoNothing()
          .returning();
        if (kind === "like" && added.length)
          await this.notify(db, book.ownerId, actor, "LIKE", id);
      } else
        await db
          .delete(table)
          .where(and(eq(table.userId, actor), eq(table.bookId, id)));
      const [{ n }] = await db
        .select({ n: count() })
        .from(bookLikes)
        .where(eq(bookLikes.bookId, id));
      await db
        .update(books)
        .set({ likeCount: Number(n) })
        .where(eq(books.id, id));
      return { active, like_count: Number(n) };
    });
  }
  async toggleFollow(target: string, actor: string, active: boolean) {
    await this.user(target);
    if (target === actor) throw new BadRequestException("不能关注自己");
    return this.db.transaction(async (tx) => {
      await this.pairLock(tx, target, actor);
      if (active) {
        if (await this.blocked(target, actor, tx))
          throw new ForbiddenException("无法关注已屏蔽的用户");
        const added = await tx
          .insert(follows)
          .values({ followerId: actor, followingId: target })
          .onConflictDoNothing()
          .returning();
        if (added.length) await this.notify(tx, target, actor, "FOLLOW");
      } else
        await tx
          .delete(follows)
          .where(
            and(eq(follows.followerId, actor), eq(follows.followingId, target)),
          );
      return { following: active };
    });
  }
  async toggleBlock(target: string, actor: string, active: boolean) {
    await this.user(target);
    if (target === actor) throw new BadRequestException("不能屏蔽自己");
    return this.db.transaction(async (tx) => {
      await this.pairLock(tx, target, actor);
      if (active) {
        await tx
          .insert(blocks)
          .values({ blockerId: actor, blockedId: target })
          .onConflictDoNothing();
        await tx
          .delete(follows)
          .where(
            or(
              and(
                eq(follows.followerId, actor),
                eq(follows.followingId, target),
              ),
              and(
                eq(follows.followerId, target),
                eq(follows.followingId, actor),
              ),
            ),
          );
      } else
        await tx
          .delete(blocks)
          .where(
            and(eq(blocks.blockerId, actor), eq(blocks.blockedId, target)),
          );
      return { blocked: active };
    });
  }
  async listComments(bookId: string, chapterId?: string, viewerId?: string) {
    await this.publicBook(bookId, viewerId);
    if (chapterId) {
      const [chapter] = await this.db
        .select()
        .from(chapters)
        .where(
          and(
            eq(chapters.id, chapterId),
            eq(chapters.bookId, bookId),
            eq(chapters.status, "PUBLISHED"),
          ),
        );
      if (!chapter) throw new NotFoundException("公开章节不存在");
    }
    const rows = await this.db
      .select({
        comment: comments,
        author: {
          id: users.id,
          username: users.username,
          name: users.name,
          avatar: users.avatar,
        },
      })
      .from(comments)
      .innerJoin(users, eq(comments.authorId, users.id))
      .where(
        and(
          eq(comments.bookId, bookId),
          chapterId
            ? eq(comments.chapterId, chapterId)
            : isNull(comments.chapterId),
          this.visibleAuthor(comments.authorId, viewerId),
        ),
      )
      .orderBy(
        desc(comments.isPinned),
        asc(comments.createdAt),
        asc(comments.id),
      );
    return rows.map((row) => toPublicComment(row.comment, row.author));
  }
  async listCommentsForChapter(id: string, viewerId?: string) {
    const [chapter] = await this.db
      .select()
      .from(chapters)
      .where(and(eq(chapters.id, id), eq(chapters.status, "PUBLISHED")));
    if (!chapter) throw new NotFoundException("公开章节不存在");
    return this.listComments(chapter.bookId, id, viewerId);
  }
  async createChapterComment(id: string, actor: string, input: CommentInput) {
    const [chapter] = await this.db
      .select()
      .from(chapters)
      .where(and(eq(chapters.id, id), eq(chapters.status, "PUBLISHED")));
    if (!chapter) throw new NotFoundException("公开章节不存在");
    return this.createComment(chapter.bookId, id, actor, input);
  }
  async createComment(
    bookId: string,
    chapterId: string | null,
    actor: string,
    input: CommentInput,
  ) {
    return this.withPublicBook(bookId, actor, async (db, book) => {
      if (!book.allowComments) throw new ForbiddenException("作者已关闭评论");
      if (chapterId) {
        const [chapter] = await db
          .select()
          .from(chapters)
          .where(
            and(
              eq(chapters.id, chapterId),
              eq(chapters.bookId, bookId),
              eq(chapters.status, "PUBLISHED"),
            ),
          )
          .for("share");
        if (!chapter) throw new NotFoundException("公开章节不存在");
      }
      let parent;
      if (input.parent_id) {
        [parent] = await db
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.id, input.parent_id),
              eq(comments.bookId, bookId),
              chapterId
                ? eq(comments.chapterId, chapterId)
                : isNull(comments.chapterId),
              isNull(comments.deletedAt),
            ),
          )
          .for("share");
        if (!parent) throw new BadRequestException("回复必须属于同一评论区");
        if (await this.blocked(actor, parent.authorId, db))
          throw new ForbiddenException("无法回复已屏蔽的用户");
      }
      const [comment] = await db
        .insert(comments)
        .values({
          bookId,
          chapterId,
          authorId: actor,
          content: input.content,
          parentId: parent?.id ?? null,
        })
        .returning();
      await db
        .update(books)
        .set({ commentCount: sql`${books.commentCount}+1` })
        .where(eq(books.id, bookId));
      await this.notify(
        db,
        book.ownerId,
        actor,
        parent?.authorId === book.ownerId ? "REPLY" : "COMMENT",
        bookId,
        comment.id,
      );
      if (parent && parent.authorId !== book.ownerId)
        await this.notify(
          db,
          parent.authorId,
          actor,
          "REPLY",
          bookId,
          comment.id,
        );
      const user = await this.user(actor, db);
      return toPublicComment(comment, {
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
      });
    });
  }
  private async moderateComment(id: string, actor: string, pin?: boolean) {
    const [found] = await this.db
      .select({ comment: comments, book: books })
      .from(comments)
      .innerJoin(books, eq(comments.bookId, books.id))
      .where(eq(comments.id, id));
    if (!found) throw new NotFoundException("评论不存在");
    if (
      actor !== found.book.ownerId &&
      (pin !== undefined || actor !== found.comment.authorId)
    )
      throw new ForbiddenException("无权管理评论");
    return this.db.transaction(async (tx) => {
      await tx
        .select()
        .from(books)
        .where(eq(books.id, found.book.id))
        .for("update");
      if (pin !== undefined) {
        const changed = await tx
          .update(comments)
          .set({ isPinned: pin, updatedAt: new Date() })
          .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
          .returning();
        if (!changed.length) throw new NotFoundException("评论不存在");
      } else {
        const changed = await tx
          .update(comments)
          .set({
            content: "",
            isPinned: false,
            deletedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
          .returning();
        if (changed.length)
          await tx
            .update(books)
            .set({ commentCount: sql`greatest(${books.commentCount}-1,0)` })
            .where(eq(books.id, found.book.id));
      }
      return { success: true };
    });
  }
  deleteComment(id: string, actor: string) {
    return this.moderateComment(id, actor);
  }
  pinComment(id: string, actor: string, pin: boolean) {
    return this.moderateComment(id, actor, pin);
  }
  async saveProgress(
    bookId: string,
    actor: string,
    chapterId: string,
    position: number,
  ) {
    return this.withPublicBook(bookId, actor, async (db) => {
      const [chapter] = await db
        .select()
        .from(chapters)
        .where(
          and(
            eq(chapters.id, chapterId),
            eq(chapters.bookId, bookId),
            eq(chapters.status, "PUBLISHED"),
          ),
        )
        .for("share");
      if (!chapter) throw new NotFoundException("公开章节不存在");
      const [row] = await db
        .insert(readingProgress)
        .values({ bookId, userId: actor, chapterId, position })
        .onConflictDoUpdate({
          target: [readingProgress.userId, readingProgress.bookId],
          set: { chapterId, position, updatedAt: new Date() },
        })
        .returning();
      return {
        chapter_id: row.chapterId,
        position: row.position,
        updated_at: row.updatedAt,
      };
    });
  }
  async listFavorites(actor: string, query: FeedQuery) {
    const filter = and(
      eq(bookFavorites.userId, actor),
      eq(books.visibility, "PUBLIC"),
      this.visibleAuthor(books.ownerId, actor),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select({ book: books, author: users })
        .from(bookFavorites)
        .innerJoin(books, eq(bookFavorites.bookId, books.id))
        .innerJoin(users, eq(books.ownerId, users.id))
        .where(filter)
        .orderBy(desc(bookFavorites.createdAt), asc(books.id))
        .limit(query.page_size)
        .offset((query.page - 1) * query.page_size),
      this.db
        .select({ n: count() })
        .from(bookFavorites)
        .innerJoin(books, eq(bookFavorites.bookId, books.id))
        .where(filter),
    ]);
    return this.page(
      await Promise.all(rows.map((r) => this.card(r.book, r.author, actor))),
      Number(total[0].n),
      query,
    );
  }
  async listNotifications(actor: string, query: FeedQuery) {
    const rows = await this.db
      .select({
        notification: notifications,
        actor: {
          id: users.id,
          username: users.username,
          name: users.name,
          avatar: users.avatar,
        },
        chapterId: comments.chapterId,
      })
      .from(notifications)
      .leftJoin(users, eq(notifications.actorId, users.id))
      .leftJoin(books, eq(notifications.bookId, books.id))
      .leftJoin(comments, eq(notifications.commentId, comments.id))
      .where(
        and(
          eq(notifications.recipientId, actor),
          this.visibleAuthor(sql`${notifications.actorId}`, actor),
          or(
            isNull(notifications.bookId),
            and(
              eq(books.visibility, "PUBLIC"),
              this.visibleAuthor(books.ownerId, actor),
            ),
          ),
          or(
            isNull(notifications.commentId),
            and(
              isNull(comments.deletedAt),
              sql`(${comments.chapterId} is null or exists (select 1 from chapters c where c.id = ${comments.chapterId} and c.status = 'PUBLISHED'))`,
            ),
          ),
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size);
    return rows.map((row) => ({
      ...toNotification(row.notification, row.actor),
      chapter_id: row.chapterId,
    }));
  }
  async markNotificationsRead(actor: string) {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(notifications.recipientId, actor), isNull(notifications.readAt)),
      );
    return { success: true };
  }
  async report(
    actor: string,
    input: {
      target_type: "BOOK" | "COMMENT" | "USER";
      target_id: string;
      reason: string;
    },
  ) {
    if (input.target_type === "BOOK")
      await this.publicBook(input.target_id, actor);
    else if (input.target_type === "USER") await this.user(input.target_id);
    else {
      const [comment] = await this.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.id, input.target_id),
            isNull(comments.deletedAt),
            this.visibleAuthor(comments.authorId, actor),
          ),
        );
      if (!comment) throw new NotFoundException("评论不存在");
      await this.publicBook(comment.bookId, actor);
      if (comment.chapterId) {
        const [chapter] = await this.db
          .select()
          .from(chapters)
          .where(
            and(
              eq(chapters.id, comment.chapterId),
              eq(chapters.status, "PUBLISHED"),
            ),
          );
        if (!chapter) throw new NotFoundException("公开章节不存在");
      }
    }
    const [report] = await this.db
      .insert(reports)
      .values({
        reporterId: actor,
        targetType: input.target_type,
        targetId: input.target_id,
        reason: input.reason,
      })
      .returning();
    return { id: report.id, status: report.status };
  }
}
