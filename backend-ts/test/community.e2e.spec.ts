import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, registerUser } from "./utils/app";
import { closeTestDb, query, truncateAll } from "./utils/db";

describe("public community database contract", () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof registerUser>>,
    reader: typeof owner,
    other: typeof owner;
  let book: string, chapter: string, draft: string;
  const get = (url: string, auth?: object) =>
    request(app.getHttpServer())
      .get("/api" + url)
      .set(auth ?? {});
  const post = (url: string, body: object = {}, auth = reader.auth) =>
    request(app.getHttpServer())
      .post("/api" + url)
      .set(auth)
      .send(body);
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll();
    owner = await registerUser(app, "owner@test.dev");
    reader = await registerUser(app, "reader@test.dev");
    other = await registerUser(app, "other@test.dev");
    book = randomUUID();
    chapter = randomUUID();
    draft = randomUUID();
    await query(
      "INSERT INTO books (id,title,owner_id,word_count) VALUES ($1,$2,$3,999)",
      [book, "星际故事", owner.user.id],
    );
    await query(
      "INSERT INTO chapters (id,book_id,title,content,status,word_count,\"order\") VALUES ($1,$3,'公开章','公开正文','PUBLISHED',10,1),($2,$3,'秘密草稿','秘密正文','DRAFT',989,2)",
      [chapter, draft, book],
    );
  });
  async function publish() {
    return post(
      `/books/${book}/publish`,
      { genre: "科幻", tags: ["星际"] },
      owner.auth,
    );
  }
  it("keeps private/draft content hidden; publish ownership and UUID errors are enforced", async () => {
    expect((await get(`/community/books/${book}`)).status).toBe(404);
    expect((await get(`/community/books/${book}/comments`)).status).toBe(404);
    expect((await publish()).status).toBe(201);
    expect((await post(`/books/${book}/publish`, {}, reader.auth)).status).toBe(
      404,
    );
    const detail = await get(`/community/books/${book}`);
    expect(detail.body.book.word_count).toBe(10);
    expect(detail.body.chapters.map((x: any) => x.id)).toEqual([chapter]);
    expect(detail.body.book).not.toHaveProperty("ownerId");
    expect(detail.body.book).not.toHaveProperty("outlines");
    expect((await get(`/community/books/${book}/chapters`)).body).toHaveLength(
      1,
    );
    for (const path of [
      `/community/books/not-uuid`,
      `/community/chapters/${draft}`,
      `/community/chapters/${draft}/comments`,
    ])
      expect((await get(path)).status).toBe(404);
    expect(
      (await get("/community/feed", { Authorization: "Bearer invalid" }))
        .status,
    ).toBe(401);
  });
  it("supports discovery, profile search, viewer flags and reading bookshelf progress", async () => {
    await publish();
    await post(`/community/books/${book}/favorite`);
    await post(`/community/books/${book}/like`);
    expect(
      (await get("/community/feed?genre=科幻&tag=星际&q=星际", reader.auth))
        .body.items[0].is_liked,
    ).toBe(true);
    expect((await get("/community/feed?genre=其它")).body.total).toBe(0);
    expect((await get("/community/search?q=星际&type=books")).body.total).toBe(
      1,
    );
    expect((await get("/community/search?q=测试&type=users")).body.total).toBe(
      3,
    );
    expect(
      (
        await post(`/community/books/${book}/progress`, {
          chapter_id: chapter,
          position: 12,
        })
      ).status,
    ).toBe(201);
    expect(
      (await get(`/community/books/${book}`, reader.auth)).body.reading_progress
        .position,
    ).toBe(12);
    const shelf = await get("/community/favorites", reader.auth);
    expect(shelf.body.items[0].reading_progress.chapter_id).toBe(chapter);
    expect(
      (
        await post(`/community/books/${book}/progress`, {
          chapter_id: draft,
          position: 4,
        })
      ).status,
    ).toBe(404);
  });
  it("serializes concurrent likes/follows and notifies only for inserted interactions", async () => {
    await publish();
    await Promise.all(
      Array.from({ length: 8 }, () => post(`/community/books/${book}/like`)),
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        post(`/community/users/${owner.user.id}/follow`),
      ),
    );
    expect(
      (await query("SELECT like_count FROM books WHERE id=$1", [book]))[0]
        .like_count,
    ).toBe(1);
    expect(
      (
        await query(
          "SELECT count(*)::int n FROM notifications WHERE recipient_id=$1",
          [owner.user.id],
        )
      )[0].n,
    ).toBe(2);
    const removals = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .delete(`/api/community/books/${book}/like`)
          .set(reader.auth),
      ),
    );
    expect(removals.every((x) => x.status === 200)).toBe(true);
    expect(
      (await query("SELECT like_count FROM books WHERE id=$1", [book]))[0]
        .like_count,
    ).toBe(0);
  });
  it("keeps reply contexts separate, preserves deleted parents and enforces author moderation", async () => {
    await publish();
    const parent = await post(`/community/books/${book}/comments`, {
      content: "父评论",
    });
    expect(
      (
        await post(`/community/chapters/${chapter}/comments`, {
          content: "错误回复",
          parent_id: parent.body.id,
        })
      ).status,
    ).toBe(400);
    const reply = await post(
      `/community/books/${book}/comments`,
      { content: "回复", parent_id: parent.body.id },
      other.auth,
    );
    expect(reply.status).toBe(201);
    expect(
      (await get("/community/notifications", reader.auth)).body.some(
        (x: any) => x.type === "REPLY",
      ),
    ).toBe(true);
    expect(
      (await post(`/community/comments/${parent.body.id}/pin`, {}, other.auth))
        .status,
    ).toBe(403);
    expect(
      (await post(`/community/comments/${parent.body.id}/pin`, {}, owner.auth))
        .status,
    ).toBe(201);
    const remove = () =>
      request(app.getHttpServer())
        .delete(`/api/community/comments/${parent.body.id}`)
        .set(owner.auth);
    await Promise.all([remove(), remove(), remove()]);
    const list = await get(`/community/books/${book}/comments`);
    expect(list.body.find((x: any) => x.id === parent.body.id).is_deleted).toBe(
      true,
    );
    expect(list.body.some((x: any) => x.id === reply.body.id)).toBe(true);
    expect(
      (await query("SELECT comment_count FROM books WHERE id=$1", [book]))[0]
        .comment_count,
    ).toBe(1);
    await query("UPDATE chapters SET status='DRAFT' WHERE id=$1", [chapter]);
    expect((await get(`/community/chapters/${chapter}/comments`)).status).toBe(
      404,
    );
  });
  it("never exposes chapter comments after draft or book privatization", async () => {
    await publish();
    await post(`/community/chapters/${chapter}/comments`, {
      content: "后来成为草稿",
    });
    await query("UPDATE chapters SET status='DRAFT' WHERE id=$1", [chapter]);
    expect((await get(`/community/books/${book}/comments`)).body).toEqual([]);
    await post(`/books/${book}/publish`, { visibility: "PRIVATE" }, owner.auth);
    expect((await get(`/community/books/${book}/comments`)).status).toBe(404);
    expect(
      (
        await post("/community/reports", {
          target_type: "BOOK",
          target_id: book,
          reason: "隐藏目标",
        })
      ).status,
    ).toBe(404);
  });
  it("blocks both directions and hides feed/comments/notifications", async () => {
    await publish();
    await post(`/community/books/${book}/comments`, { content: "评论" });
    await post(`/community/users/${owner.user.id}/block`);
    expect(
      (await get(`/community/users/${owner.user.id}`, reader.auth)).body.profile
        .is_blocked,
    ).toBe(true);
    expect((await get("/community/feed", reader.auth)).body.total).toBe(0);
    expect((await post(`/community/books/${book}/like`)).status).toBe(403);
    expect(
      (await post(`/community/users/${reader.user.id}/follow`, {}, owner.auth))
        .status,
    ).toBe(403);
    expect(
      (await get(`/community/books/${book}/comments`, owner.auth)).body,
    ).toEqual([]);
    expect((await get("/community/notifications", owner.auth)).body).toEqual(
      [],
    );
    expect((await post(`/community/users/${randomUUID()}/block`)).status).toBe(
      404,
    );
  });
  it("validates public report targets and updates profile whitelist", async () => {
    await publish();
    expect(
      (
        await post("/community/reports", {
          target_type: "COMMENT",
          target_id: randomUUID(),
          reason: "不存在",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post("/community/reports", {
          target_type: "BOOK",
          target_id: book,
          reason: "内容问题",
        })
      ).status,
    ).toBe(201);
    const res = await request(app.getHttpServer())
      .put("/api/community/profile")
      .set(reader.auth)
      .send({
        username: "reader_public",
        bio: "简介",
        avatar: "https://example.test/avatar.png",
      });
    expect(res.status).toBe(200);
    expect(res.body.avatar).toBe("https://example.test/avatar.png");
    expect(res.body).not.toHaveProperty("email");
  });
  it("persists publication metadata and limits malformed progress/profile inputs", async () => {
    const published = await post(
      `/books/${book}/publish`,
      {
        status: "FINISHED",
        tags: ["星际", "星际"],
        genre: "科幻",
        allow_comments: false,
      },
      owner.auth,
    );
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({
      visibility: "PUBLIC",
      status: "FINISHED",
      allow_comments: false,
    });
    expect(JSON.parse(published.body.tags)).toEqual(["星际"]);
    expect((await get("/books", owner.auth)).body[0].visibility).toBe("PUBLIC");
    expect(
      (await post(`/community/books/${book}/comments`, { content: "禁用评论" }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(`/community/books/${book}/progress`, {
          chapter_id: chapter,
          position: 2147483648,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer())
          .put("/api/community/profile")
          .set(reader.auth)
          .send({ username: "valid_name", avatar: "javascript:alert(1)" })
      ).status,
    ).toBe(400);
    const firstTime = published.body.published_at;
    await post(`/books/${book}/publish`, { visibility: "PRIVATE" }, owner.auth);
    const republish = await publish();
    expect(republish.body.published_at).toBe(firstTime);
  });
  it("routes chapter notifications, paginates them, and never exposes hidden chapter reports", async () => {
    await publish();
    const comment = await post(`/community/chapters/${chapter}/comments`, {
      content: "章节评论",
    });
    const note = (await get("/community/notifications?page_size=1", owner.auth))
      .body;
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({
      chapter_id: chapter,
      comment_id: comment.body.id,
    });
    expect(
      (await get("/community/notifications?page=2&page_size=1", owner.auth))
        .body,
    ).toEqual([]);
    expect(
      (await post("/community/notifications/read", {}, owner.auth)).status,
    ).toBe(200);
    expect(
      (await get("/community/notifications", owner.auth)).body[0].read_at,
    ).toBeTruthy();
    await query("UPDATE chapters SET status='DRAFT' WHERE id=$1", [chapter]);
    expect((await get("/community/notifications", owner.auth)).body).toEqual(
      [],
    );
    expect(
      (
        await post("/community/reports", {
          target_type: "COMMENT",
          target_id: comment.body.id,
          reason: "隐藏章节",
        })
      ).status,
    ).toBe(404);
  });
  it("applies both directions of blocking to direct chapter reads and replies", async () => {
    await publish();
    const comment = await post(`/community/books/${book}/comments`, {
      content: "根评论",
    });
    await post(`/community/users/${reader.user.id}/block`, {}, other.auth);
    expect(
      (
        await post(
          `/community/books/${book}/comments`,
          { content: "回复", parent_id: comment.body.id },
          other.auth,
        )
      ).status,
    ).toBe(403);
    await post(`/community/users/${owner.user.id}/block`);
    expect(
      (await get(`/community/chapters/${chapter}`, reader.auth)).status,
    ).toBe(404);
    expect(
      (await get(`/community/books/${book}/chapters`, reader.auth)).status,
    ).toBe(404);
  });
  it('returns follow/block states used by the profile buttons',async()=>{
    expect((await post(`/community/users/${owner.user.id}/follow`)).body.following).toBe(true);
    expect((await request(app.getHttpServer()).delete(`/api/community/users/${owner.user.id}/follow`).set(reader.auth)).body.following).toBe(false);
    expect((await post(`/community/users/${owner.user.id}/block`)).body.blocked).toBe(true);
    expect((await request(app.getHttpServer()).delete(`/api/community/users/${owner.user.id}/block`).set(reader.auth)).body.blocked).toBe(false);
  });

});
