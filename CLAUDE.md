# AI 写作助手项目介绍

## 📋 项目概述

这是一个基于 **NestJS + Vue3** 的 AI 写作辅助平台，旨在帮助网文作者提升写作效率。项目集成 DeepSeek-V3.2 等多个大语言模型，支持续写、润色、校对、大纲生成、Diff 润色等功能，并通过 RAG（检索增强生成）技术提升内容一致性。

> **架构说明**：后端已从 Python/FastAPI 重写为 TypeScript（`backend-ts/`，API 契约逐项对齐，前端零改动完成切换）。
> 旧的 Python 实现保留在 `backend/` 作为参考答案，不再作为主后端运行。

---

## ✨ 功能特性

### 🎯 核心功能
| 功能 | 描述 |
|------|------|
| **AI 续写** | 根据已有内容自然延续故事情节 |
| **智能润色** | 优化表达，使语言更生动 |
| **Diff 润色** | 对比原文与润色结果，显示差异摘要 |
| **文字校对** | 修正错别字、语法错误和标点问题 |
| **内容总结** | 抓住核心情节进行简洁概括 |
| **大纲生成** | 根据设定自动生成小说大纲 |
| **人物抽取** | 从正文识别人物并入库（JSON 解析容错） |
| **多模型切换** | 支持 DeepSeek/GLM/MiniMax 等模型 |
| **深色模式** | 支持深色/浅色主题切换 |

### 🧠 RAG 检索增强
- 文本向量化存储（bge-large-zh-v1.5，**pgvector `vector(1024)` 列**，库内余弦距离排序取 top-5）
- 文本智能分块（500 字/块，100 字重叠，按码点切分）
- 保存章节自动重建索引（先删后插，单块向量化失败跳过、不阻塞保存）
- 提升 AI 续写内容与全书设定的一致性

### 🧠 作品记忆（Story Memory）
- 续写/聊天/润色时自动拼装：作品信息 + 人物设定 + 大纲 + 最近前 3 章 + RAG 检索 + 当前草稿
- polish-diff 用更紧的上下文预算变体（不含 RAG）

### 🔐 用户认证
- JWT Token 认证（HS256，payload `{sub, exp}`）
- bcrypt 密码加密（兼容 Python 版 `$2b$` 哈希，数据可直接迁移）
- 用户注册/登录/信息管理

---

## 🛠 技术栈

| 层次 | 技术 | 版本 |
|------|------|------|
| 前端框架 | Vue3 | ^3.4 |
| 状态管理 | Pinia | ^2.1 |
| 构建工具 | Vite | ^5.0 |
| CSS 框架 | TailwindCSS | ^3.4 |
| **后端框架** | **NestJS（Express adapter）** | **^11.1** |
| **ORM** | **Drizzle ORM** | **^0.44** |
| **数据库** | **PostgreSQL + pgvector**（pgvector/pgvector:pg17） | 17 |
| **认证** | **jose（JWT）+ bcryptjs** | - |
| **HTTP 客户端** | **undici（连接池/SSE 流式解析）** | ^7 |
| AI 模型 | DeepSeek-V3.2 / GLM-4 / MiniMax（SiliconFlow） | - |
| 向量模型 | BAAI/bge-large-zh-v1.5 | - |
| 部署 | Docker + Docker Compose | - |
| 测试 | Vitest + supertest（**172 个用例**） | ^3.2 |

> 旧版 Python 技术栈：FastAPI ^0.104 + SQLAlchemy ^2.0 + SQLite（`backend/`，保留参考）。

---

## 🚀 快速开始

### 方式一：Docker 部署（推荐）

```bash
# 1. 复制环境变量（必须设置 SECRET_KEY，可选 SILICONFLOW_API_KEY）
cp .env.docker.example .env && nano .env

# 2. 启动服务
SECRET_KEY=your-secret docker compose up --build

# 访问地址
# 前端：http://localhost         （nginx → backend-ts）
# 后端：http://localhost:8001     （NestJS，主后端）
# 参考：http://localhost:8000     （Python 旧版，参考实现）
# API文档：http://localhost:8001/api/health
```

### 方式二：本地开发

```bash
# 启动数据库（docker compose 里带 dev 库 + 测试库）
docker compose up -d postgres postgres-test

# 启动后端（NestJS）
cd backend-ts
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5435/ai_writing npm run dev

# 启动前端（新开终端）
cd frontend
npm run dev
```

### 方式三：一键脚本

```bash
./start.sh   # 启动服务
./stop.sh    # 停止服务
```

---

## 📁 项目结构

```
ai-writing-assistant/
├── backend-ts/                 # ✅ 主后端（NestJS + Drizzle + PostgreSQL）
│   ├── src/
│   │   ├── main.ts             # 入口：全局前缀 api、CORS、body 20mb、启动迁移
│   │   ├── app.module.ts
│   │   ├── config/env.ts       # zod 校验环境变量（镜像 config.py）
│   │   ├── db/                 # drizzle.module / schema（8 表，FK 真级联）/ migrate
│   │   ├── core/               # 全局异常过滤器（{detail} 中文文案）、UUID 管道、zod 管道
│   │   ├── auth/               # JWT 认证（403/401 阶梯与 Python 逐级对齐）
│   │   ├── books/              # 书籍/章节/设定库 + demo seed（字节级对齐）
│   │   ├── ai/                 # AI 控制器（8 端点 + SSE）、prompts、story-memory、
│   │   │   │                   #   text-diff、extraction、llm/（undici SiliconFlow 客户端）
│   │   ├── rag/                # RAG：切块/余弦/pgvector 索引与检索
│   │   └── shared/             # chinese-number、text（码点级 wordCount/切片）
│   ├── test/                   # 172 个 Vitest 用例（单测 + supertest e2e + 真socket SSE 解析）
│   ├── tools/import-sqlite.ts  # 旧 SQLite 数据 → PostgreSQL 一次性迁移
│   ├── drizzle.config.ts / Dockerfile / vitest.config.ts
├── backend/                    # 📚 Python/FastAPI 旧实现（参考答案，冻结不动）
├── frontend/                   # 前端 Vue3 应用（迁移期间零改动）
│   ├── src/…                   #   组件/视图/状态与之前一致
│   └── nginx.conf              # 镜像内配置（本地由 deploy/nginx.conf 挂载覆盖）
├── deploy/nginx.conf           # 本地 cutover 的 nginx 配置（/api → backend-ts:8001，不剥前缀）
├── docker-compose.yml          # backend / backend-ts / postgres(+5435) / postgres-test(5434) / frontend
├── render.yaml                 # 线上部署（API 已指向 backend-ts）
├── start.sh / stop.sh
├── CLAUDE.md
└── .env.docker.example
```

---

## 🔌 API 接口（契约与 Python 版逐项对齐）

### 认证接口
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/auth/register` | 用户注册（200） |
| POST | `/api/auth/login` | 用户登录（200） |
| GET | `/api/auth/profile` | 获取当前用户 |

### 书籍管理（创建 201 / 删除 204）
| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/books` | 获取书籍列表 |
| POST | `/api/books` | 创建书籍 |
| GET | `/api/books/{id}` | 获取书籍详情（含 5 个集合） |
| PUT | `/api/books/{id}` | 更新书籍 |
| DELETE | `/api/books/{id}` | 删除书籍 |
| GET | `/api/books/stats` | 书籍统计（camelCase） |
| GET | `/api/stats` | 写作统计（注册在 `/books/:id` 之前） |
| POST | `/api/demo/seed` | 演示数据种子（幂等） |

### 章节管理
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/books/{bookId}/chapters` | 创建章节（自动「第X章」命名） |
| GET | `/api/chapters/{id}` | 获取章节 |
| PUT | `/api/chapters/save` | 保存章节（重算字数 + RAG 向量化） |
| PUT | `/api/books/{bookId}/chapters/{chapterId}` | 更新章节（标题/状态） |
| DELETE | `/api/books/{bookId}/chapters/{chapterId}` | 删除章节（级联删向量块） |
| POST | `/api/chapters/publish` | 发布章节 |

### 设定库
| 方法 | 路径 | 描述 |
|------|------|------|
| GET/POST | `/api/books/{bookId}/outlines` | 大纲 |
| GET/POST | `/api/books/{bookId}/characters` | 人物 |
| GET/POST/DELETE | `/api/books/{bookId}/character-relations` | 人物关系 |
| GET/POST | `/api/books/{bookId}/inspirations` | 灵感（tags 为 JSON 字符串） |

### AI 服务
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/ai/chat` | AI 聊天（非流式） |
| POST | `/api/ai/chat/stream` | AI 聊天（流式 SSE） |
| POST | `/api/ai/write` | AI 写作辅助（非流式） |
| POST | `/api/ai/write/stream` | AI 写作辅助（流式 SSE） |
| POST | `/api/ai/polish-diff` | Diff 润色 |
| POST | `/api/ai/polish-diff/stream` | Diff 润色（流式，meta→token→result→done） |
| POST | `/api/ai/extract-characters` | 人物抽取（坏 JSON → 502） |
| POST | `/api/ai/outline` | 生成大纲 |

**SSE 协议**：`data: {"type":"token","data":{"text":...}}` → `done` → 字面量 `data: [DONE]`；错误以 in-band `{"type":"error"}` 传递（HTTP 仍 200）；响应头含 `X-Accel-Buffering: no`。

---

## 🧪 测试说明

```bash
cd backend-ts
docker compose up -d postgres-test   # 测试库（localhost:5434）
npm test                             # Vitest：16 个文件 / 172 个用例
npx tsc --noEmit                     # 类型检查
```

覆盖模块：
- 认证（JWT/bcrypt、403→401 阶梯、**Python $2b$ 哈希互通**）
- 书籍/章节/设定库 e2e（含 3 处越权写洞的回归测试）
- AI 控制器（假 LLM 注入：prompt 拼装、SSE 协议、错误文案）
- **undici SSE 解析器（真 socket：断行帧/坏 JSON 行/[DONE] 哨兵/网络重试）**
- RAG（切块、余弦、保存写块、**删章级联删块**、**pgvector 排序 == 暴力余弦排序**）
- chinese-number / text-diff / extraction / prompts 单测

---

## 🔄 数据迁移（SQLite → PostgreSQL）

```bash
cd backend-ts
# 把旧 Python 后端的 SQLite 数据导入 Postgres（幂等，可重跑）
npx tsx tools/import-sqlite.ts ../backend/writing_platform.db \
  postgres://postgres:postgres@localhost:5435/ai_writing
```

迁移规则：naive UTC 时间 → timestamptz；`$2b$` 密码哈希原样照搬（旧密码可登录）；embedding JSON → pgvector 向量（坏数据置 NULL）；孤儿行（Python 版 SQLite 无 FK 的遗留）按父表过滤并统计。

---

## 🎨 深色模式

项目支持深色/浅色主题切换，通过 CSS 变量实现：

```css
:root {
    --text-primary: #1a1a2e;
    --bg-primary: #ffffff;
    --brand: #6366f1;
}

[data-theme="dark"] {
    --text-primary: #f3f4f6;
    --bg-primary: #111827;
    --brand: #818cf8;
}
```

---

## 🌐 环境变量配置

```bash
# 必填
SECRET_KEY=your-secret-key          # JWT 加密密钥（与 Python 版一致则 token 互通）
DATABASE_URL=postgres://user:pass@host:5432/ai_writing   # 需要 pgvector 扩展

# 可选
SILICONFLOW_API_KEY=your-api-key    # SiliconFlow API Key（AI 功能）
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
DEEPSEEK_MODEL=deepseek-ai/DeepSeek-V4-Flash
ACCESS_TOKEN_EXPIRE_MINUTES=1440
RUN_MIGRATIONS=true                 # 启动时自动跑迁移（compose/render 默认开）
```

---

## 📊 技术亮点

| 特性 | 说明 |
|------|------|
| **流式输出** | undici 手写 SSE 解析器（断行帧/坏帧/[DONE] 哨兵），Express 手写 SSE 响应 |
| **RAG 检索** | pgvector 库内余弦排序，替代 Python 版全表载入循环（附带对照测试） |
| **Diff 对比** | 字符级 diff + 「≤4 字等片段粘连」启发式 + 变更摘要 |
| **多模型支持** | 5 个模型可选：DeepSeek-V4-Flash、DeepSeek-V3.2、GLM-4.7、GLM-Z1-32B、MiniMax-M2.5 |
| **契约冻结迁移** | FastAPI → NestJS 全量重写，前端零改动切换（状态码/错误体/SSE 逐项对齐） |
| **跨后端兼容** | 同 SECRET_KEY 下新旧 token 互认；Python $2b$ 哈希在 TS 侧可直接验证 |
| **安全修复** | 补 3 处越权写洞（outline/character/inspiration 创建）；FK 真级联（删章不再孤儿化向量块） |
| **性能修复** | stats 由 N+1 重写为 2-3 条聚合查询；nginx 剥前缀 bug 修复 |
| **单元测试** | 172 个用例（Python 版 111 → 净增 61，覆盖越权/级联/解析器/契约对齐） |

---

## 📝 AI 输出优化

为确保 AI 输出纯净的正文内容，System Prompt 中添加了硬性规定：

### 续写（continue）
- 只输出小说正文，禁止对话、提问、建议
- 禁止前缀、标题、括号注释
- 禁止分析性句子、元评论

### 润色（improve）
- 只输出润色后正文
- 禁止修改说明、前后对比
- 禁止元语句、标题、注释

### 校对（fix）
- 只输出校对后正文
- 禁止错误列表、前后对比
- 禁止标注、说明

### Diff 润色（polish_diff）
- 对比原文和润色结果
- 显示变更摘要（如：将「非常好」改为「特别棒」）
- 支持一键应用润色结果

---

## 📧 项目信息

- **GitHub**: https://github.com/tbyang28/ai-writing-assistant
- **作者**: Tianbo Yang
- **用途**: 实习面试项目展示
- **最新更新**: 2026年9月

---

*最后更新: 2026年9月22日*
