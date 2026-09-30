# Public Writing Community Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public writing community to the existing NestJS + Vue3 application, including published works, discovery, reader pages, profiles, follows, likes, favorites, comments, notifications, reports, and blocks.

**Architecture:** Keep the existing private authoring workspace and add a `community` NestJS module with explicit public DTOs and ownership checks. Extend the current PostgreSQL/Drizzle schema with publication metadata and social tables; add a Vue Pinia store and lazy-loaded routes for discovery, profiles, public books, reader pages, and notifications.

**Tech Stack:** NestJS 11, Drizzle ORM, PostgreSQL/pgvector, Zod, Vitest, Vue 3, Pinia, Vue Router, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-09-30-public-community-design.md`

## Global Constraints

- Keep drafts, unpublished chapters, outlines, characters, relations, inspirations, and RAG chunks private.
- Public reads use explicit whitelist DTOs; never serialize complete Drizzle records.
- All mutating endpoints require JWT; ownership checks use the current authenticated user.
- Likes, follows, favorites, and blocks are idempotent through database uniqueness constraints.
- Use existing NestJS/Drizzle/Vue patterns; do not add a second ORM or state library.
- Run backend build, frontend build, and database-backed tests when PostgreSQL/pgvector is available.

---

### Task 1: Extend database schema and migration

**Files:**
- Modify: `backend-ts/src/db/schema.ts`
- Create: `backend-ts/drizzle/0001_public_community.sql`
- Modify: `backend-ts/src/auth/auth.service.ts`
- Modify: `backend-ts/src/auth/dto.ts`
- Test: `backend-ts/test/community-schema.spec.ts`

**Interfaces:**
- Produces typed Drizzle tables for public book metadata, profiles, follows, likes, favorites, comments, reading progress, notifications, reports, and blocks.

- [ ] **Step 1: Write failing schema tests** asserting the public columns and uniqueness constraints are exported.
- [ ] **Step 2: Run `npm test -- community-schema.spec.ts` and verify the missing-table failure.**
- [ ] **Step 3: Add schema tables, foreign keys, indexes, and book/user columns.**
- [ ] **Step 4: Add the SQL migration with `ALTER TABLE`, `CREATE TABLE`, indexes, foreign keys, and unique constraints.**
- [ ] **Step 5: Extend registration/user response with a generated username and public bio validation.**
- [ ] **Step 6: Run the focused schema/auth tests and commit.**

### Task 2: Add community service, DTOs, and public API

**Files:**
- Create: `backend-ts/src/community/community.module.ts`
- Create: `backend-ts/src/community/community.service.ts`
- Create: `backend-ts/src/community/dto.ts`
- Create: `backend-ts/src/community/mappers.ts`
- Create: `backend-ts/src/community/discovery.controller.ts`
- Create: `backend-ts/src/community/social.controller.ts`
- Modify: `backend-ts/src/app.module.ts`
- Modify: `backend-ts/src/books/books.controller.ts`
- Test: `backend-ts/test/community.service.spec.ts`
- Test: `backend-ts/test/community.e2e.spec.ts`

**Interfaces:**
- `CommunityService.listFeed(params, viewerId?)` returns paginated public book cards.
- `CommunityService.getPublicBook(bookId, viewerId?)` returns a public book plus author and published chapters only.
- `CommunityService.getProfile(userId, viewerId?)` returns public profile, counts, and public books.
- Controllers expose `/community/*` reads and authenticated social mutations.

- [ ] **Step 1: Write failing service tests for private-book filtering, unpublished-chapter filtering, and idempotent likes/follows.**
- [ ] **Step 2: Run focused tests and confirm failures are caused by missing service behavior.**
- [ ] **Step 3: Implement explicit public mappers and feed/profile/book queries.**
- [ ] **Step 4: Implement publish/unpublish on owned books and profile update endpoint.**
- [ ] **Step 5: Implement follow, like, favorite, block, report, and notification creation with unique-conflict-safe toggles.**
- [ ] **Step 6: Register the module and add E2E coverage for public access and ownership boundaries.**
- [ ] **Step 7: Run focused backend tests and commit.**

### Task 3: Add comments, reader progress, and notifications

**Files:**
- Modify: `backend-ts/src/community/community.service.ts`
- Modify: `backend-ts/src/community/social.controller.ts`
- Modify: `backend-ts/src/community/dto.ts`
- Test: `backend-ts/test/community-comments.e2e.spec.ts`

**Interfaces:**
- `GET/POST /community/books/:id/comments`
- `GET/POST /community/chapters/:id/comments`
- `DELETE /community/comments/:id`
- `POST /community/comments/:id/pin`
- `GET /community/notifications`
- `POST /community/books/:id/progress`

- [ ] **Step 1: Write failing tests for comment ownership, author pinning, reply creation, content length validation, and notification creation.**
- [ ] **Step 2: Run the focused E2E test and verify red.**
- [ ] **Step 3: Implement plain-text comment validation, public comment mapping, and permission checks.**
- [ ] **Step 4: Implement progress upsert and paginated notifications with read-state update.**
- [ ] **Step 5: Run focused tests and commit.**

### Task 4: Build Vue community experience

**Files:**
- Create: `frontend/src/stores/community.ts`
- Create: `frontend/src/views/DiscoverView.vue`
- Create: `frontend/src/views/PublicBookView.vue`
- Create: `frontend/src/views/ReaderView.vue`
- Create: `frontend/src/views/ProfileView.vue`
- Create: `frontend/src/views/NotificationsView.vue`
- Modify: `frontend/src/main.ts`
- Modify: `frontend/src/components/Sidebar.vue`
- Modify: `frontend/src/views/BooksView.vue`
- Modify: `frontend/src/api/index.ts`
- Test: `frontend/src/stores/community.test.ts`

**Interfaces:**
- Store methods: `fetchFeed`, `fetchPublicBook`, `fetchProfile`, `toggleFollow`, `toggleLike`, `toggleFavorite`, `createComment`, `fetchNotifications`.
- Routes: `/discover`, `/community/books/:id`, `/community/books/:id/read/:chapterId`, `/community/users/:id`, `/notifications`.

- [ ] **Step 1: Write failing store tests for feed loading and optimistic-safe toggle state.**
- [ ] **Step 2: Implement API wrappers and Pinia state with loading/error handling.**
- [ ] **Step 3: Implement discovery cards, filters, pagination, empty state, and public navigation.**
- [ ] **Step 4: Implement public book detail and reader pages with chapter navigation, comments, progress, and author actions.**
- [ ] **Step 5: Implement profile and notification pages.**
- [ ] **Step 6: Add publish controls to `BooksView.vue` and community links to the sidebar.**
- [ ] **Step 7: Run TypeScript checks and production build, then commit.**

### Task 5: Verification, deployment, and integration

**Files:**
- Modify: `README.md`
- Modify: `render.yaml` or deployment configuration only if required by migration startup.
- Test: full backend and frontend suites.

- [ ] **Step 1: Start PostgreSQL/pgvector and run migrations against a clean test database.**
- [ ] **Step 2: Run the complete backend test suite and frontend production build.**
- [ ] **Step 3: Exercise public registration, publish, browse, read, comment, follow, and notification flows against the local services.**
- [ ] **Step 4: Update README with community routes and deployment notes.**
- [ ] **Step 5: Commit all feature changes, push `feat/public-community`, and trigger the configured deployment.**
- [ ] **Step 6: Check deployed health and frontend URL, then report exact commit and URLs.**
