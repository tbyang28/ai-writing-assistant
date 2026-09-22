#!/bin/bash

# ============================================
# AI 写作助手 - 一键启动脚本
# ============================================

echo "================================================"
echo "         AI 写作助手 - 一键启动脚本"
echo "================================================"
echo ""

# 检查命令是否存在
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 检查 Docker（主后端依赖 PostgreSQL + pgvector）
if ! command_exists docker; then
    echo "❌ 未找到 Docker，请先安装并启动 Docker Desktop"
    exit 1
fi

# 检查主后端依赖
if [ ! -d "backend-ts/node_modules" ]; then
    echo "❌ NestJS 后端依赖不存在，请先安装"
    echo "   cd backend-ts && npm ci"
    exit 1
fi

# 检查前端依赖
if [ ! -d "frontend/node_modules" ]; then
    echo "❌ 前端依赖不存在，请先安装"
    echo "   cd frontend && npm ci"
    exit 1
fi

# 创建日志目录
mkdir -p logs

# Compose 文件包含旧参考服务的必填变量；本地开发未提供时使用仅限本机的默认值。
export SECRET_KEY="${SECRET_KEY:-local-development-secret}"

echo "🚀 启动 PostgreSQL + pgvector..."
docker compose up -d postgres

echo "⏳ 等待数据库就绪..."
for attempt in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U postgres -d ai_writing >/dev/null 2>&1; then
        break
    fi
    if [ "$attempt" -eq 30 ]; then
        echo "❌ PostgreSQL 在 30 秒内未就绪"
        exit 1
    fi
    sleep 1
done

echo "🚀 启动 NestJS 后端服务..."
cd backend-ts
PORT=8001 DATABASE_URL=postgres://postgres:postgres@localhost:5435/ai_writing RUN_MIGRATIONS=true npm run dev > ../logs/backend.log 2>&1 &
BACKEND_PID=$!
echo "✅ 后端服务已启动 (PID: $BACKEND_PID)"
echo "   访问地址: http://localhost:8001"
echo "   健康检查: http://localhost:8001/api/health"

echo ""

echo "🚀 启动前端服务..."
cd ../frontend
VITE_API_URL=http://localhost:8001/api npm run dev > ../logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo "✅ 前端服务已启动 (PID: $FRONTEND_PID)"
echo "   访问地址: http://localhost:5173"

echo ""
echo "================================================"
echo "         服务启动完成！"
echo "================================================"
echo ""
echo "📖 前端页面: http://localhost:5173"
echo "🔌 后端API: http://localhost:8001"
echo "📝 健康检查: http://localhost:8001/api/health"
echo ""
echo "🛑 停止服务: ./stop.sh"
echo "📋 查看日志: tail -f logs/backend.log 或 tail -f logs/frontend.log"

# 保存PID到文件
echo "$BACKEND_PID" > ../logs/backend.pid
echo "$FRONTEND_PID" > ../logs/frontend.pid

# 返回根目录
cd ..
