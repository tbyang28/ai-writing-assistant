# AI 写作助手

一个基于 FastAPI + Vue3 的智能网文写作平台，集成 DeepSeek-V3.2 大语言模型，提供AI续写、润色、校对、大纲生成等功能。

## 功能特性

- ✅ 用户认证与授权（JWT）
- ✅ 书籍管理（创建、编辑、删除）
- ✅ AI智能对话
- ✅ AI续写功能
- ✅ AI润色优化
- ✅ AI校对修正
- ✅ 内容摘要生成
- ✅ 大纲自动生成
- ✅ 流式输出体验

## 技术栈

### 后端
- FastAPI 0.115 - 高性能 Web 框架
- SQLAlchemy 2.0 - ORM 数据库操作
- JWT (python-jose) - 用户认证
- httpx - 异步 HTTP 客户端
- SQLite - 数据库

### 前端
- Vue 3.5 - 渐进式 JavaScript 框架
- TypeScript - 类型安全
- Pinia - 状态管理
- Vue Router - 路由管理
- Tailwind CSS - 原子化 CSS 框架
- Vite - 构建工具
- Axios - HTTP 客户端

### AI 服务
- DeepSeek-V3.2 - 大语言模型
- SiliconFlow API - 模型调用平台

## 快速开始

### 前置要求
- Python 3.9+
- Node.js 18+
- 硅基流动 API Key（获取地址：https://cloud.siliconflow.cn）

### 后端启动

1. 进入后端目录
```bash
cd backend
```

2. 创建虚拟环境并激活
```bash
python -m venv venv
source venv/bin/activate  # Linux/Mac
.\venv\Scripts\activate  # Windows
```

3. 安装依赖
```bash
pip install -r requirements.txt
```

4. 配置环境变量
```bash
# 复制 .env 示例文件并配置
# 编辑 .env 文件，填入你的 API Key
SILICONFLOW_API_KEY=你的API密钥
```

5. 启动服务
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

后端服务将在 http://localhost:8000 启动

### 前端启动

1. 进入前端目录
```bash
cd frontend
```

2. 安装依赖
```bash
npm install
```

3. 启动开发服务器
```bash
npm run dev
```

前端服务将在 http://localhost:5173 启动

## API 文档

后端启动后访问：http://localhost:8000/docs

## 项目结构

```
ai-writing-assistant/
├── backend/
│   ├── app/
│   │   ├── models/          # 数据模型
│   │   ├── routers/         # API 路由
│   │   ├── schemas/         # Pydantic 模式
│   │   ├── services/        # 业务逻辑
│   │   ├── config.py        # 配置
│   │   ├── database.py      # 数据库
│   │   └── main.py          # 主应用
│   ├── requirements.txt     # Python 依赖
│   └── .env                 # 环境变量
└── frontend/
    ├── src/
    │   ├── components/      # Vue 组件
    │   ├── views/           # 页面视图
    │   ├── stores/          # Pinia 状态管理
    │   ├── api/             # API 调用
    │   └── assets/          # 静态资源
    ├── package.json         # Node 依赖
    └── vite.config.ts       # Vite 配置
```

## 学习路径

这个项目可以作为学习以下技术的实战案例：

1. FastAPI 异步编程
2. JWT 用户认证机制
3. Vue3 Composition API
4. Pinia 状态管理
5. 大模型 API 集成
6. 流式输出（SSE）处理

## 许可证

MIT License
