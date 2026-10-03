# AI Copilot 写作平台

面向长篇小说创作的 AI 全栈写作平台，基于 **NestJS + Vue3 + TypeScript**。作者可以管理章节、设定与角色关系，使用多模型 AI 续写、润色和校对；读者可以发现公开作品、阅读章节并参与讨论。

**[在线体验](https://ai-writing-assistant-web.onrender.com/discover)** · **[后端健康检查](https://ai-writing-assistant-api-o4nb.onrender.com/api/health)** · **[线上版本源码](https://github.com/tbyang28/ai-writing-assistant/tree/feat/public-community)**

> 当前线上服务跟随 `feat/public-community` 分支，包含社区阅读和新版 AI 编辑流程。`main` 保留作者创作核心；本文展示线上版本，本地复现请使用上述分支。当前后端为 `backend-ts/`（NestJS + Drizzle + PostgreSQL），部署使用这一套服务。

## 核心功能

| 场景 | 功能 |
|------|------|
| 创作工作台 | 作品、章节、大纲、角色、灵感管理，字数统计与写作日历 |
| AI 写作 | 续写、润色、校对、摘要、自定义指令、大纲生成，多模型切换 |
| 可控编辑 | SSE 流式生成、停止生成、原文与结果差异审阅、确认应用和撤销 |
| 长篇设定 | RAG 召回相关章节背景，人物识别与角色关系图 |
| 社区阅读 | 发现与搜索作品、作品详情、独立阅读器、作者主页 |
| 读者互动 | 关注、点赞、收藏、阅读进度、评论与回复、通知 |
| 示例体验 | 一键初始化《雨巷边缘》的章节、角色、关系、大纲和灵感 |

导航按 **工作台、创作管理、社区阅读、数据回顾** 分组。进入功能页面时，左侧自动收起为图标窄栏，给正文留出空间；回到首页自动展开，也可以手动切换。

## 页面展示

以下均为实际页面截图。发现页和阅读器来自线上公开作品；作者侧页面使用本地示例数据。截图来源见 [截图说明](docs/screenshots/README.md)。

### 章节编辑与 AI 助手

正文、章节目录和 AI 工具在同一页面，进入编辑器后全局导航自动收起。

![章节编辑器与 AI 助手](docs/screenshots/editor-ai-panel.png)

### 发现公开作品

按分类浏览、搜索作品，进入作品详情和阅读器。

![发现公开作品](docs/screenshots/community-discover.png)

### 独立阅读器

专注正文阅读，支持章节切换、阅读设置和章节讨论。

![独立阅读器](docs/screenshots/reader-view.png)

### 作者工作台

集中查看作品、总字数、章节数量和近期写作情况。

![作者工作台](docs/screenshots/dashboard-overview.png)

### 角色关系图

查看角色关系网络，选中角色后查看人物设定。

![角色关系图](docs/screenshots/character-graph.png)

## AI 编辑流程

1. 在章节中选择文本，或使用整章作为处理范围，选择续写、润色、校对等操作。
2. 选择模型并发送指令，结果通过 SSE 持续显示，可随时停止。
3. 审阅原文与建议结果的差异，接受、重试、调整指令或放弃。
4. 确认后写回正文，支持撤销；聊天回答保留在对话中。

续写支持在光标或选区末尾插入。生成期间正文发生变化时，过期结果不能直接应用，避免覆盖新的编辑。

## 公开作品社区

作品默认私密。作者在“我的作品”中设置分类、标签和评论选项后发布作品，并在编辑器中单独发布章节。只有公开作品中处于 `PUBLISHED` 状态的章节对读者可见。

| 页面 | 路径 | 用途 |
|------|------|------|
| 发现 | `/discover` | 最新/热门、分类、标签、搜索 |
| 作品详情 | `/community/books/:id` | 简介、公开目录、点赞、收藏、评论 |
| 阅读器 | `/community/books/:id/read/:chapterId` | 正文、章节切换、阅读进度、章节讨论 |
| 作者主页 | `/community/users/:id` | 公开资料、作品、关注 |
| 我的收藏 | `/bookshelf` | 收藏作品与继续阅读 |
| 通知 | `/notifications` | 关注、点赞、评论与回复通知 |

未登录用户可以浏览和阅读，登录后可以互动。评论支持回复，评论作者与作品作者可以删除评论，作品作者可以置顶；举报保存为待处理记录，支持拉黑。

公开接口使用字段白名单，邮箱、密码、草稿章节以及大纲、角色、灵感和 RAG 片段不进入社区响应。取消公开或将章节转回草稿后，社区接口不再返回这些内容。

## 技术栈与架构

| 模块 | 技术 |
|------|------|
| 前端 | Vue3、TypeScript、Pinia、Vue Router、Tailwind CSS、Vite |
| 后端 | NestJS、Express、Drizzle ORM、PostgreSQL、pgvector |
| AI | SiliconFlow Chat Completions、DeepSeek / GLM / MiniMax、SSE |
| RAG | bge-large-zh-v1.5、文本分块、Embedding、余弦距离检索 |
| 认证 | JWT、bcryptjs |
| 工程化 | Docker Compose、Vitest、Render Blueprint |

```mermaid
flowchart LR
  User[作者与读者] --> Frontend[Vue3 + TypeScript + Pinia]
  Frontend -->|REST / SSE| API[NestJS API]
  API --> Auth[JWT 认证]
  API --> Books[作品 / 章节 / 角色 / 社区]
  API --> AI[AI Service]
  Books --> DB[(PostgreSQL + pgvector)]
  AI --> Memory[RAG / 故事记忆]
  Memory --> DB
  Memory --> Embed[SiliconFlow Embedding]
  AI --> LLM[SiliconFlow Chat Completions]
```

### RAG 检索增强

```mermaid
flowchart TD
  Save[保存章节] --> Split[500 字分块 / 100 字重叠]
  Split --> Embed[bge-large-zh-v1.5 向量化]
  Embed --> Store[(document_chunks / 1024 维向量)]
  Query[续写或提问] --> QEmbed[输入向量化]
  QEmbed --> Search[按本书过滤 / pgvector 余弦距离排序]
  Store --> Search
  Search --> TopK[取最相关 Top 5 片段]
  TopK --> Context[拼接相关背景]
  Context --> Prompt[注入 Prompt 并生成]
```

章节分块保留重叠文本，减少上下文在边界处丢失。检索在 PostgreSQL 中完成，按作品隔离，再由故事记忆服务组装背景。向量化失败不会阻塞章节保存；旧块删除与新块插入在事务内替换。

### 多模型接入

前端选择模型后在请求中传入 `model`，后端通过 `SiliconFlowClient` 统一调用。未指定时使用 `DEEPSEEK_MODEL` 环境变量。

| 面板选项 | 模型 ID |
|----------|---------|
| DeepSeek-V4-Flash | `deepseek-ai/DeepSeek-V4-Flash` |
| DeepSeek-V3.2 | `deepseek-ai/DeepSeek-V3.2` |
| GLM-4.7 | `zai-org/GLM-4.7` |
| MiniMax-M2.5 | `MiniMaxAI/MiniMax-M2.5` |

实际可调用模型取决于 SiliconFlow 账号和服务端配置。

## 快速开始

需要 Node.js 20+、npm 和 Docker。以下使用当前线上分支。

```bash
git clone https://github.com/tbyang28/ai-writing-assistant.git
cd ai-writing-assistant
git switch feat/public-community
cp .env.docker.example .env
```

编辑根目录 `.env`，填写 `SECRET_KEY` 和 `SILICONFLOW_API_KEY`。前者用于 JWT 签名，后者用于 AI 与向量化。

### Docker Compose

```bash
docker compose up --build
```

访问前端 `http://localhost`，后端 `http://localhost:8001`，健康检查 `http://localhost/api/health`。Compose 启动 NestJS、PostgreSQL（含 pgvector）和 Nginx 前端，启动后端时执行数据库迁移。

```bash
docker compose down
```

### 本地开发

先在仓库根目录启动开发数据库，并准备后端配置：

```bash
docker compose up -d postgres
cp backend-ts/.env.example backend-ts/.env
```

编辑 `backend-ts/.env`，填写自己的 `SECRET_KEY` 和 `SILICONFLOW_API_KEY`。本地数据库通过 `localhost:5435` 访问，启动时使用下面的连接串：

```bash
cd backend-ts
npm ci
PORT=8001 \
DATABASE_URL=postgres://postgres:postgres@localhost:5435/ai_writing \
RUN_MIGRATIONS=true \
npm run dev
```

另开终端，在仓库根目录启动前端：

```bash
cd frontend
npm ci
VITE_API_URL=http://localhost:8001/api npm run dev
```

访问 `http://localhost:5173`。完成配置和依赖安装后，也可以使用根目录的 `./start.sh` 与 `./stop.sh` 启停本地服务。

## 环境变量

Docker Compose 读取根目录 `.env`；本地 NestJS 读取 `backend-ts/.env`。示例文件分别为 `.env.docker.example` 和 `backend-ts/.env.example`。

| 变量 | 用途 |
|------|------|
| `SECRET_KEY` | JWT 签名密钥 |
| `SILICONFLOW_API_KEY` | AI 与 Embedding 调用密钥 |
| `DATABASE_URL` | PostgreSQL 连接串，数据库需要 `vector` 扩展 |
| `SILICONFLOW_BASE_URL` | 默认 `https://api.siliconflow.cn/v1` |
| `DEEPSEEK_MODEL` | 默认生成模型，请求中的 `model` 可覆盖 |
| `PORT` | 本地后端端口通常为 `8001`，Render 注入线上端口 |
| `RUN_MIGRATIONS` | 是否在启动时执行 Drizzle 迁移 |
| `ALGORITHM` | JWT 算法，默认 `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Token 有效期，默认 `1440` 分钟 |
| `VITE_API_URL` | 前端构建时的 API 地址；本地开发指向 `http://localhost:8001/api` |

Compose 内部数据库地址为 `postgres:5432`，宿主机本地开发使用 `localhost:5435`。

## 测试与构建

前端检查涵盖 AI 编辑变更、故事记忆以及线上分支的阅读与社区状态处理：

```bash
cd frontend
npm ci
npm test
npx vue-tsc --noEmit
npm run build
```

后端覆盖认证、作品权限、章节/角色 API、AI Prompt、Diff、RAG 分块与检索、SSE 取消，以及社区发布与互动。测试依赖独立的 PostgreSQL 测试库；先在根目录执行：

```bash
docker compose up -d postgres-test
```

然后运行：

```bash
cd backend-ts
npm ci
npm test
npm run build
```

测试库使用 `localhost:5434/ai_writing_test`，与开发库分开。具体用例数量随分支变化，以执行结果为准。

## Render 部署

仓库提供 `render.yaml`，通过 Render Blueprint 创建 NestJS Web Service 和 Vue 静态站点：

1. 连接 GitHub 仓库，并选择要部署的分支；当前线上为 `feat/public-community`。
2. 配置后端 `DATABASE_URL`、`SILICONFLOW_API_KEY` 和 JWT 密钥；数据库需支持 pgvector。
3. 将前端 `VITE_API_URL` 设置为后端公网地址加 `/api`，然后重新构建前端。
4. 后端启动时通过 `RUN_MIGRATIONS=true` 执行增量迁移。

```env
VITE_API_URL=https://你的后端服务地址.onrender.com/api
```

生产数据保存在 PostgreSQL 中。免费后端实例长时间无访问后可能休眠，首次请求需要等待服务唤醒。

## 项目结构

```text
ai-writing-assistant/
├── backend-ts/
│   ├── src/           # NestJS：认证、作品、AI、RAG、社区
│   ├── drizzle/       # 数据库迁移
│   └── test/          # Vitest 单元与接口测试
├── frontend/
│   └── src/           # Vue 页面、组件、Pinia 与编辑工具
├── deploy/            # Nginx 部署配置
├── docs/screenshots/  # 页面截图及来源说明
├── docker-compose.yml
├── render.yaml
└── start.sh / stop.sh
```

社区模块和新版 AI 编辑流程见 `feat/public-community` 分支。后续计划包括 RAG 命中片段展示、全文设定一致性检查、检索性能基准，以及富文本编辑与作品导出。

作者：**Tianbo Yang** · 用途：AI 全栈开发实习项目展示
