# AI 写作助手

一个基于 FastAPI + Vue3 的智能网文写作平台，集成 DeepSeek-V3.2 大语言模型，提供 AI 续写、润色、校对、大纲生成等功能，并支持 **RAG 检索增强**（语义搜索全书内容）。

## ✨ 功能特性

### 🎯 核心功能
- ✅ 用户认证与授权（JWT）
- ✅ 书籍管理（创建、编辑、删除）
- ✅ 章节管理（创建、保存、发布）
- ✅ 角色管理（角色档案与关系）
- ✅ 灵感收集与管理
- ✅ 大纲管理

### 🤖 AI 功能
- ✅ AI 智能对话
- ✅ AI 续写功能（流式输出）
- ✅ AI 润色优化
- ✅ AI 校对修正
- ✅ 内容摘要生成
- ✅ 大纲自动生成
- ✅ **RAG 检索增强**（语义搜索全书，保持内容一致性）

### 🚀 便捷工具
- ✅ 一键启动脚本（`./start.sh`）
- ✅ 一键停止脚本（`./stop.sh`）
- ✅ 自动日志记录

## 🛠️ 技术栈

### 后端
| 技术 | 版本 | 说明 |
|------|------|------|
| FastAPI | 0.115 | 高性能异步 Web 框架 |
| SQLAlchemy | 2.0 | ORM 数据库操作 |
| JWT (python-jose) | - | 用户认证 |
| httpx | - | 异步 HTTP 客户端 |
| SQLite | - | 轻量级数据库 |

### 前端
| 技术 | 版本 | 说明 |
|------|------|------|
| Vue | 3.5 | 渐进式 JavaScript 框架 |
| TypeScript | 5.6 | 类型安全 |
| Pinia | 2.2 | 状态管理 |
| Vue Router | 4.4 | 路由管理 |
| Tailwind CSS | 3.4 | 原子化 CSS 框架 |
| Vite | 5.4 | 构建工具 |
| Axios | 1.7 | HTTP 客户端 |

### AI 服务
| 服务 | 说明 |
|------|------|
| DeepSeek-V3.2 | 大语言模型 |
| SiliconFlow API | 模型调用平台 |
| BAAI/bge-large-zh-v1.5 | 向量嵌入模型（用于 RAG） |

## 🚀 快速开始

### 前置要求
- Python 3.9+
- Node.js 18+
- 硅基流动 API Key（获取地址：https://cloud.siliconflow.cn）

### 🏃 一键启动（推荐）

```bash
# 进入项目目录
cd ai-writing-assistant

# 一键启动（首次使用前请先安装依赖）
./start.sh
```

### 📦 手动安装依赖

**后端依赖：**
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Linux/Mac
.\venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

**前端依赖：**
```bash
cd frontend
npm install
```

### ⚙️ 配置环境变量

编辑 `backend/.env` 文件：
```env
SILICONFLOW_API_KEY=你的API密钥
DEEPSEEK_MODEL=deepseek-ai/DeepSeek-V3.2
```

### 📝 手动启动

**后端：**
```bash
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**前端：**
```bash
cd frontend
npm run dev
```

### 🛑 停止服务

```bash
./stop.sh
```

## 🌐 访问地址

| 服务 | 地址 |
|------|------|
| 前端页面 | http://localhost:5173 |
| 后端 API | http://localhost:8000 |
| API 文档 | http://localhost:8000/docs |

## 📁 项目结构

```
ai-writing-assistant/
├── backend/
│   ├── app/
│   │   ├── models/          # 数据模型（含 RAG 向量存储）
│   │   ├── routers/         # API 路由
│   │   ├── schemas/         # Pydantic 模式
│   │   ├── services/        # 业务逻辑（含 RAG 服务）
│   │   ├── config.py        # 配置
│   │   ├── database.py      # 数据库连接
│   │   ├── dependencies.py  # 依赖注入
│   │   └── main.py          # 主应用
│   ├── requirements.txt     # Python 依赖
│   └── .env                 # 环境变量
├── frontend/
│   ├── src/
│   │   ├── components/      # Vue 组件
│   │   ├── views/           # 页面视图
│   │   ├── stores/          # Pinia 状态管理
│   │   ├── api/             # API 调用
│   │   └── assets/          # 静态资源
│   ├── package.json         # Node 依赖
│   └── vite.config.ts       # Vite 配置
├── logs/                    # 日志目录（自动创建）
├── start.sh                 # 一键启动脚本
├── stop.sh                  # 一键停止脚本
└── README.md                # 项目说明
```

## 🧠 RAG 检索增强

本项目集成了 RAG（Retrieval-Augmented Generation）功能：

**工作原理：**
1. 章节保存时自动将内容切块并向量化
2. AI 续写时自动搜索全书语义相近的段落
3. 将相关内容作为上下文提供给 AI，确保生成内容与全书设定一致

**优势：**
- 支持语义搜索（近义词匹配）
- 避免前后内容矛盾
- 自动关联已有情节

## 📚 学习路径

这个项目可以作为学习以下技术的实战案例：

1. **FastAPI 异步编程** - 高性能后端开发
2. **JWT 用户认证机制** - 安全的身份验证
3. **Vue3 Composition API** - 现代前端开发
4. **Pinia 状态管理** - 响应式状态管理
5. **大模型 API 集成** - AI 应用开发
6. **流式输出（SSE）** - 实时数据推送
7. **RAG 检索增强** - 提升 AI 生成质量

## 📊 功能对比

| 功能 | 描述 |
|------|------|
| AI 续写 | 根据已有内容自然延续故事情节 |
| AI 润色 | 优化表达，使语言更生动 |
| AI 校对 | 修正错别字、语法错误 |
| AI 大纲 | 生成详细的小说大纲 |
| RAG 搜索 | 语义搜索全书相关内容 |

## 📝 许可证

MIT License

---

**项目地址：** https://github.com/tbyang28/ai-writing-assistant