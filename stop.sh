#!/bin/bash

# ============================================
# AI 写作助手 - 停止脚本
# ============================================

echo "================================================"
echo "         AI 写作助手 - 停止脚本"
echo "================================================"
echo ""

# 停止后端服务
if [ -f "logs/backend.pid" ]; then
    BACKEND_PID=$(cat logs/backend.pid)
    echo "⏹️  停止后端服务 (PID: $BACKEND_PID)"
    kill "$BACKEND_PID" 2>/dev/null || true
    rm -f logs/backend.pid
    echo "✅ 后端服务已停止"
else
    echo "ℹ️  后端服务未运行"
fi

# 停止前端服务
if [ -f "logs/frontend.pid" ]; then
    FRONTEND_PID=$(cat logs/frontend.pid)
    echo "⏹️  停止前端服务 (PID: $FRONTEND_PID)"
    kill "$FRONTEND_PID" 2>/dev/null || true
    rm -f logs/frontend.pid
    echo "✅ 前端服务已停止"
else
    echo "ℹ️  前端服务未运行"
fi

echo ""
echo "================================================"
echo "         所有服务已停止！"
echo "================================================"