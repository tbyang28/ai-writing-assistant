# 公开作品社区设计

## 目标

在现有 AI 写作工作台上增加公开作品社区，让作者主动发布作品后被发现、阅读和讨论，同时保持编辑器、大纲、角色、灵感和 RAG 数据私有。

## 产品范围

### 第一阶段（本次实现）

- 作者资料页：公开用户名、头像、简介和公开作品。
- 作品发布：私密/公开状态、分类、标签、简介、封面、连载/完结状态。
- 发现页：最新发布、热门作品、分类和标签筛选。
- 公开作品详情与阅读页：章节目录、已发布章节、上一章/下一章。
- 关注作者、点赞作品、收藏作品。
- 作品和章节评论、评论回复、作者删除评论、评论置顶。
- 举报作品/评论/用户、拉黑用户。
- 通知中心：关注、点赞、评论和回复通知。
- 公开接口只返回公开作品和已发布章节，不返回工作台设定数据。

### 后续阶段（不在本次实现）

- 私信和实时消息。
- 共读小组、投稿和编辑推荐。
- 多人协作写作和版本审阅。

## 访问与权限

- 未登录用户可以浏览发现页、作者页、公开作品和已发布章节。
- 登录用户可以关注、点赞、收藏、评论、回复、举报和拉黑。
- 作品默认 `PRIVATE`；只有作者主动发布后才进入公开查询。
- 草稿章节不出现在公开章节目录。
- 作品内部的大纲、角色、角色关系、灵感和 RAG 文档永远不进入社区 DTO。
- 作品写入和发布操作必须校验当前用户为 `owner_id`。
- 被拉黑用户的公开互动内容不显示给拉黑者；被举报内容保留记录，管理员后续可处理。

## 数据模型

在 `books` 增加：

- `visibility`: `PRIVATE` 或 `PUBLIC`。
- `genre`: 可选分类字符串。
- `tags`: JSON 字符串数组。
- `published_at`: 首次公开时间。
- `read_count`, `like_count`, `comment_count`: 展示计数。
- `allow_comments`: 是否允许评论。

在 `users` 增加：

- `username`: 唯一公开用户名。
- `bio`: 公开简介。

新增表：

- `follows(follower_id, following_id, created_at)`，关注关系唯一。
- `book_likes(user_id, book_id, created_at)`，作品点赞唯一。
- `book_favorites(user_id, book_id, created_at)`，作品收藏唯一。
- `comments(id, book_id, chapter_id, author_id, parent_id, content, is_pinned, deleted_at, created_at, updated_at)`。
- `reading_progress(user_id, book_id, chapter_id, position, updated_at)`。
- `notifications(id, recipient_id, actor_id, type, book_id, comment_id, read_at, created_at)`。
- `reports(id, reporter_id, target_type, target_id, reason, status, created_at)`。
- `blocks(blocker_id, blocked_id, created_at)`，拉黑关系唯一。

所有用户、作品和内容引用使用 PostgreSQL UUID 外键；删除用户或作品时按现有级联策略清理关联数据。

## API

公开读取：

- `GET /community/feed?sort=latest|popular&genre=&tag=&page=`
- `GET /community/books/:id`
- `GET /community/books/:id/chapters`
- `GET /community/chapters/:id`
- `GET /community/users/:id`
- `GET /community/search?q=&type=books|users`

登录操作：

- `POST /books/:id/publish`
- `POST|DELETE /community/users/:id/follow`
- `POST|DELETE /community/books/:id/like`
- `POST|DELETE /community/books/:id/favorite`
- `GET|POST /community/books/:id/comments`
- `GET|POST /community/chapters/:id/comments`
- `DELETE /community/comments/:id`
- `POST /community/comments/:id/pin`
- `GET /community/notifications`
- `POST /community/reports`
- `POST|DELETE /community/users/:id/block`

## 前端页面

- `DiscoverView.vue`：发现流、筛选和分页。
- `PublicBookView.vue`：作品简介、作者信息、目录、互动入口。
- `ReaderView.vue`：正文阅读、章节导航、评论。
- `ProfileView.vue`：作者资料、公开作品和关注状态。
- `NotificationsView.vue`：通知列表和已读状态。
- `stores/community.ts`：社区数据和互动状态。

侧边栏新增“发现”“我的书架”“通知”；编辑器作品卡增加“发布到社区/取消公开”。

## 安全与质量要求

- 公开查询使用显式 DTO 白名单，禁止直接序列化完整 `books` 或 `chapters` 记录。
- 点赞、关注、收藏、拉黑使用数据库唯一约束保证幂等。
- 评论内容限制长度并进行基础 HTML 转义/纯文本展示。
- API 对评论、举报和互动操作保留 JWT 认证；公开 GET 不要求 JWT。
- 为核心公开读取、越权保护、互动幂等和评论权限添加 Vitest/E2E 测试。
- 前端必须通过 TypeScript 检查和生产构建。

## 验收标准

1. 作者可以把自己的作品发布为公开，其他未登录用户可以看到作品简介和已发布章节。
2. 未发布作品、草稿章节和工作台设定不会通过任何社区接口泄漏。
3. 登录用户可以关注作者、点赞/收藏作品、发表评论和回复；重复操作不会产生重复记录。
4. 作者可以删除或置顶自己作品下的评论，其他用户不能越权操作。
5. 举报、拉黑和通知接口可用，前端有对应入口和反馈状态。
6. 后端构建、前端构建和可用数据库环境下的完整测试通过。
