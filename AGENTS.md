# AI 写作助手项目介绍

## 📋 项目概述

这是一个基于 FastAPI + Vue3 的 AI 写作辅助平台，旨在帮助网文作者提升写作效率。项目集成了 DeepSeek-V3.2 等多个大语言模型，支持续写、润色、校对、大纲生成等功能，并通过 RAG（检索增强生成）技术提升内容一致性。

---

## ✨ 功能特性

### 🎯 核心功能
| 功能 | 描述 |
|------|------|
| **AI 续写** | 根据已有内容自然延续故事情节 |
| **智能润色** | 优化表达，使语言更生动 |
| **文字校对** | 修正错别字、语法错误和标点问题 |
| **内容总结** | 抓住核心情节进行简洁概括 |
| **大纲生成** | 根据设定自动生成小说大纲 |
| **多模型切换** | 支持 DeepSeek/GLM/MiniMax 等模型 |

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
| 后端框架 | FastAPI | ^0.104 |
| 数据库 | SQLite + SQLAlchemy | ^2.0 |
| AI 模型 | DeepSeek-V3.2 / GLM-4 / MiniMax | - |
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
│   │   ├── config.py          # 配置管理
│   │   ├── main.py            # 入口文件
│   │   ├── database.py        # 数据库连接
│   │   ├── models/            # SQLAlchemy 模型
│   │   ├── schemas/           # Pydantic 数据结构
│   │   ├── routers/           # API 路由
│   │   │   ├── auth.py        # 用户认证
│   │   │   ├── books.py       # 书籍管理
│   │   │   └── ai.py          # AI 服务
│   │   └── services/          # 业务逻辑
│   │       ├── ai_service.py  # AI 模型调用
│   │       ├── rag_service.py # RAG 检索增强
│   │       └── auth.py        # 认证服务
│   ├── tests/                 # 单元测试（111个用例）
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                   # 前端 Vue3 应用
│   ├── src/
│   │   ├── components/        # 组件
│   │   │   └── AiPanel.vue    # AI 助手面板
│   │   ├── stores/            # Pinia 状态管理
│   │   ├── views/             # 页面视图
│   │   └── main.ts
│   └── Dockerfile
├── docker-compose.yml         # Docker 编排
├── start.sh / stop.sh         # 一键启动脚本
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
| DELETE | `/api/books/{id}` | 删除书籍 |

### AI 服务
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/ai/chat` | AI 聊天（非流式） |
| POST | `/api/ai/chat/stream` | AI 聊天（流式） |
| POST | `/api/ai/write` | AI 写作辅助 |
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
# - AI 服务测试（消息构建、Prompt 管理）
# - RAG 服务测试（向量相似度、文本分块）
# - API 路由测试
# - 认证依赖测试

# 测试结果：111 passed
```

---

## 🌐 环境变量配置

```bash
# 必填配置
SECRET_KEY=your-secret-key          # JWT 加密密钥
SILICONFLOW_API_KEY=your-api-key    # SiliconFlow API Key

# 可选配置
DEEPSEEK_MODEL=deepseek-ai/DeepSeek-V3.2
ACCESS_TOKEN_EXPIRE_MINUTES=1440
DATABASE_URL=sqlite+aiosqlite:///./writing_platform.db
```

---

## 📊 对比学长项目

| 特性 | 当前项目 | 学长项目 |
|------|----------|---------|
| 框架 | FastAPI + Vue3 | Flask + React |
| AI 模型 | 多模型切换 | 单一模型 |
| RAG 检索 | ✅ 已实现 | ❌ 无 |
| Docker 部署 | ✅ 已实现 | ✅ |
| 单元测试 | ✅ 111个用例 | ✅ |
| 角色关系图 | ❌ | ✅ |

---

## 📝 下一步优化计划

1. **全文分析** - 伏笔分析、角色弧线、节奏分析
2. **角色关系图** - SVG 可视化角色关系网络
3. **写作统计** - 字数统计、写作日历、连续天数
4. **富文本编辑器** - TipTap 富文本编辑
5. **导出功能** - TXT/Markdown/EPUB 导出

---

## 📧 项目信息

- **GitHub**: https://github.com/tbyang28/ai-writing-assistant
- **作者**: Tianbo Yang
- **用途**: 实习面试项目展示

---

*最后更新: 2026年5月*
