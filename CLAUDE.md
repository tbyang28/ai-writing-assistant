# AI 写作助手项目介绍

## 📋 项目概述

这是一个基于 FastAPI + Vue3 的 AI 写作辅助平台，旨在帮助网文作者提升写作效率。项目集成了 DeepSeek-V3.2 等多个大语言模型，支持续写、润色、校对、大纲生成、Diff 润色等功能，并通过 RAG（检索增强生成）技术提升内容一致性。

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
| **多模型切换** | 支持 DeepSeek/GLM/MiniMax 等模型 |
| **深色模式** | 支持深色/浅色主题切换 |

### 🧠 RAG 检索增强
- 文本向量化存储（使用 bge-large-zh-v1.5）
- 余弦相似度语义搜索
- 文本智能分块（500字/块，100字重叠）
- 提升 AI 续写内容与全书设定的一致性

### 🔐 用户认证
- JWT Token 认证
- bcrypt 密码加密
- 用户注册/登录/信息管理

---

## 🛠 技术栈

| 层次 | 技术 | 版本 |
|------|------|------|
| 前端框架 | Vue3 | ^3.4 |
| 状态管理 | Pinia | ^2.1 |
| 构建工具 | Vite | ^5.0 |
| CSS 框架 | TailwindCSS | ^3.4 |
| 后端框架 | FastAPI | ^0.104 |
| 数据库 | SQLite + SQLAlchemy | ^2.0 |
| AI 模型 | DeepSeek-V3.2 / GLM-4 / MiniMax | - |
| 向量模型 | BAAI/bge-large-zh-v1.5 | - |
| 部署 | Docker + Docker Compose | - |
| 测试 | pytest | ^7.4 |

---

## 🚀 快速开始

### 方式一：Docker 部署（推荐）

```bash
# 1. 复制环境变量
cp .env.docker.example .env

# 2. 编辑 .env，填入 SiliconFlow API Key
nano .env

# 3. 启动服务
docker-compose up --build

# 访问地址
# 前端：http://localhost
# 后端：http://localhost:8000
# API文档：http://localhost:8000/docs
```

### 方式二：本地开发

```bash
# 启动后端
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 启动前端（新开终端）
cd frontend
npm run dev
```

### 方式三：一键脚本

```bash
# 启动服务
./start.sh

# 停止服务
./stop.sh
```

---

## 📁 项目结构

```
ai-writing-assistant/
├── backend/                    # 后端 FastAPI 服务
│   ├── app/
│   │   ├── config.py          # 配置管理 + AI 模型列表
│   │   ├── main.py            # 入口文件
│   │   ├── database.py        # 数据库连接
│   │   ├── models/            # SQLAlchemy 模型
│   │   │   ├── user.py        # 用户模型
│   │   │   ├── book.py        # 书籍模型
│   │   │   ├── chapter.py     # 章节模型
│   │   │   └── embedding.py   # 向量存储模型
│   │   ├── schemas/           # Pydantic 数据结构
│   │   │   ├── user.py
│   │   │   ├── book.py
│   │   │   ├── chapter.py
│   │   │   └── ai.py          # AI 请求/响应模型
│   │   ├── routers/           # API 路由
│   │   │   ├── auth.py        # 用户认证
│   │   │   ├── books.py       # 书籍管理
│   │   │   ├── chapters.py    # 章节管理
│   │   │   └── ai.py          # AI 服务
│   │   └── services/          # 业务逻辑
│   │       ├── ai_service.py  # AI 模型调用 + Diff 功能
│   │       ├── rag_service.py # RAG 检索增强
│   │       └── auth.py        # 认证服务
│   ├── tests/                 # 单元测试（111个用例）
│   │   ├── conftest.py        # pytest 配置
│   │   ├── services/           # 服务层测试
│   │   ├── routers/            # 路由层测试
│   │   └── schemas/            # 数据结构测试
│   ├── requirements.txt
│   ├── pytest.ini
│   ├── Dockerfile
│   └── .dockerignore
├── frontend/                   # 前端 Vue3 应用
│   ├── src/
│   │   ├── components/        # 组件
│   │   │   ├── AiPanel.vue    # AI 助手面板
│   │   │   └── Sidebar.vue    # 侧边栏
│   │   ├── stores/            # Pinia 状态管理
│   │   │   ├── ai.ts          # AI 状态
│   │   │   ├── auth.ts        # 认证状态
│   │   │   └── theme.ts       # 主题状态
│   │   ├── views/             # 页面视图
│   │   │   ├── AuthView.vue   # 登录/注册
│   │   │   ├── HomeView.vue   # 首页
│   │   │   └── EditorView.vue # 编辑器
│   │   ├── assets/
│   │   │   └── main.css       # 全局样式 + CSS 变量
│   │   ├── App.vue
│   │   └── main.ts
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── nginx.conf             # Nginx 配置
│   └── tailwind.config.js
├── docker-compose.yml         # Docker 编排
├── start.sh / stop.sh         # 一键启动脚本
├── CLAUDE.md                  # 项目介绍文档
└── .env.docker.example        # 环境变量示例
```

---

## 🔌 API 接口

### 认证接口
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/auth/register` | 用户注册 |
| POST | `/api/auth/login` | 用户登录 |
| GET | `/api/auth/me` | 获取当前用户 |

### 书籍管理
| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/books` | 获取书籍列表 |
| POST | `/api/books` | 创建书籍 |
| GET | `/api/books/{id}` | 获取书籍详情 |
| PUT | `/api/books/{id}` | 更新书籍 |
| DELETE | `/api/books/{id}` | 删除书籍 |

### 章节管理
| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/chapters/{id}` | 获取章节 |
| PUT | `/api/chapters/save` | 保存章节 |
| DELETE | `/api/chapters/{id}` | 删除章节 |

### AI 服务
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/ai/chat` | AI 聊天（非流式） |
| POST | `/api/ai/chat/stream` | AI 聊天（流式 SSE） |
| POST | `/api/ai/write` | AI 写作辅助（非流式） |
| POST | `/api/ai/write/stream` | AI 写作辅助（流式） |
| POST | `/api/ai/outline` | 生成大纲 |

---

## 🧪 测试说明

```bash
# 运行所有测试
cd backend
source venv/bin/activate
pytest tests/ -v

# 测试覆盖模块
# - 认证服务测试（密码哈希、JWT Token）
# - AI 服务测试（消息构建、Prompt 管理、Diff 功能）
# - RAG 服务测试（向量相似度、文本分块）
# - API 路由测试
# - 认证依赖测试

# 测试结果：111 passed
```

---

## 🎨 深色模式

项目支持深色/浅色主题切换，通过 CSS 变量实现：

```css
:root {
    --text-primary: #1a1a2e;
    --text-secondary: #6b7280;
    --text-muted: #9ca3af;
    --bg-primary: #ffffff;
    --surface-secondary: #f3f4f6;
    --border-clr: #e5e7eb;
    --brand: #6366f1;
}

[data-theme="dark"] {
    --text-primary: #f3f4f6;
    --text-secondary: #d1d5db;
    --text-muted: #9ca3af;
    --bg-primary: #111827;
    --surface-secondary: #1f2937;
    --border-clr: #374151;
    --brand: #818cf8;
}
```

---

## 🌐 环境变量配置

```bash
# 必填配置
SECRET_KEY=your-secret-key          # JWT 加密密钥
SILICONFLOW_API_KEY=your-api-key    # SiliconFlow API Key

# 可选配置
DEEPSEEK_MODEL=deepseek-ai/DeepSeek-V3.2
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
ACCESS_TOKEN_EXPIRE_MINUTES=1440
DATABASE_URL=sqlite+aiosqlite:///./writing_platform.db
```

---

## 📊 技术亮点

| 特性 | 说明 |
|------|------|
| **流式输出** | 使用 SSE 实现打字机效果 |
| **RAG 检索** | 向量化全文内容，提升 AI 回答一致性 |
| **Diff 对比** | 字符级别差异对比，生成变更摘要 |
| **多模型支持** | 5 个模型可选：DeepSeek-V4-Flash、DeepSeek-V3.2、GLM-4.7、GLM-Z1-32B、MiniMax-M2.5 |
| **Proxy 问题修复** | 禁用系统代理，避免网络问题导致 500 错误 |
| **单元测试** | 111 个测试用例，覆盖核心模块 |

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
- **最新更新**: 2026年5月

---

*最后更新: 2026年5月26日*
