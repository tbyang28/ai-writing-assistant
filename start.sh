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

# 检查后端虚拟环境
if [ ! -d "backend/venv" ]; then
    echo "❌ 后端虚拟环境不存在，请先安装依赖"
    echo "   cd backend && python -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi

# 检查前端依赖
if [ ! -d "frontend/node_modules" ]; then
    echo "❌ 前端依赖不存在，请先安装"
    echo "   cd frontend && npm install"
    exit 1
fi

# 创建日志目录
mkdir -p logs

echo "🚀 启动后端服务..."
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 > ../logs/backend.log 2>&1 &
BACKEND_PID=$!
echo "✅ 后端服务已启动 (PID: $BACKEND_PID)"
echo "   访问地址: http://localhost:8000"
echo "   API文档: http://localhost:8000/docs"

echo ""

echo "🚀 启动前端服务..."
cd ../frontend
npm run dev > ../logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo "✅ 前端服务已启动 (PID: $FRONTEND_PID)"
echo "   访问地址: http://localhost:5173"

echo ""
echo "================================================"
echo "         服务启动完成！"
echo "================================================"
echo ""
echo "📖 前端页面: http://localhost:5173"
echo "🔌 后端API: http://localhost:8000"
echo "📝 API文档: http://localhost:8000/docs"
echo ""
echo "🛑 停止服务: ./stop.sh"
echo "📋 查看日志: tail -f logs/backend.log 或 tail -f logs/frontend.log"

# 保存PID到文件
echo "$BACKEND_PID" > ../logs/backend.pid
echo "$FRONTEND_PID" > ../logs/frontend.pid

# 返回根目录
cd ..