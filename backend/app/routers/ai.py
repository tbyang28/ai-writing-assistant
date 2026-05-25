import json
import traceback

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.dependencies import get_current_user
from app.models import User, Book, Chapter
from app.schemas.ai import AiChatRequest, AiWriteRequest, AiGenerateOutlineRequest, AiResponse
from app.services.ai_service import call_siliconflow, build_messages
from app.services.rag_service import build_rag_context, index_chapter


def _extract_ai_error(e: Exception) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        try:
            body = e.response.json()
            msg = body.get("message", str(e))
            if "insufficient" in msg.lower() or "余额" in msg:
                return "SiliconFlow 账户余额不足，请充值后重试"
            return f"AI 服务错误 ({e.response.status_code}): {msg}"
        except Exception:
            pass
    return f"AI 服务调用失败: {str(e)}"

router = APIRouter(prefix="/api/ai", tags=["ai"])


async def verify_book_access(book_id: str, user_id: str, db: AsyncSession) -> Book:
    result = await db.execute(
        select(Book).where(Book.id == book_id, Book.owner_id == user_id)
    )
    book = result.scalar_one_or_none()
    if not book:
        raise HTTPException(status_code=404, detail="作品不存在")
    return book


@router.post("/chat")
async def ai_chat(
    data: AiChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI对话（非流式）"""
    await verify_book_access(data.book_id, current_user.id, db)

    try:
        user_msg = data.message
        if data.current_content:
            user_msg = f"当前章节内容：\n{data.current_content[:2000]}\n\n用户问题：\n{data.message}"

        messages = build_messages("chat", user_msg, data.history)
        result = await call_siliconflow(messages, stream=False, model=data.model)
        return {"data": result}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=_extract_ai_error(e))


@router.post("/chat/stream")
async def ai_chat_stream(
    data: AiChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI对话（流式SSE）"""
    await verify_book_access(data.book_id, current_user.id, db)

    async def generate():
        try:
            user_msg = data.message
            if data.current_content:
                user_msg = f"当前章节内容：\n{data.current_content[:2000]}\n\n用户问题：\n{data.message}"

            messages = build_messages("chat", user_msg, data.history)
            async for chunk in await call_siliconflow(messages, stream=True, model=data.model):
                yield f"data: {json.dumps({'type': 'token', 'data': {'text': chunk}})}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'data': {}})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'data': {'message': _extract_ai_error(e)}})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/write")
async def ai_write(
    data: AiWriteRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI写作辅助（续写/润色/校对/摘要）"""
    await verify_book_access(data.book_id, current_user.id, db)

    try:
        command = data.command
        content = data.selected_text or data.content

        if command == "continue":
            # RAG: 搜索全书中与当前内容相关的段落作为背景
            rag_context = await build_rag_context(db, content[:1000], data.book_id)
            user_msg = f"以下是小说的当前内容，请续写：\n\n{content[:3000]}"
            if rag_context:
                # 把搜索到的相关背景塞进 prompt，AI 会知道之前发生过什么
                user_msg = f"{rag_context}\n\n以下是小说的当前内容，请续写：\n\n{content[:3000]}"
        elif command == "improve":
            user_msg = f"请润色以下文本：\n\n{content[:3000]}"
        elif command == "fix":
            user_msg = f"请校对以下文本，修正错别字和语病：\n\n{content[:3000]}"
        elif command == "summarize":
            user_msg = f"请概括以下内容：\n\n{content[:3000]}"
        else:
            user_msg = content[:3000]

        messages = build_messages(command, user_msg)
        result = await call_siliconflow(messages, stream=False, model=data.model)
        return {"data": result}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=_extract_ai_error(e))


@router.post("/write/stream")
async def ai_write_stream(
    data: AiWriteRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI写作辅助（流式SSE）—— 一个字一个字返回，不用等全部算完"""
    await verify_book_access(data.book_id, current_user.id, db)

    async def generate():
        try:
            command = data.command
            content = data.selected_text or data.content

            if command == "continue":
                # RAG: 搜索全书中与当前内容相关的段落作为背景
                rag_context = await build_rag_context(db, content[:1000], data.book_id)
                user_msg = f"以下是小说的当前内容，请续写：\n\n{content[:3000]}"
                if rag_context:
                    user_msg = f"{rag_context}\n\n以下是小说的当前内容，请续写：\n\n{content[:3000]}"
            elif command == "improve":
                user_msg = f"请润色以下文本：\n\n{content[:3000]}"
            elif command == "fix":
                user_msg = f"请校对以下文本，修正错别字和语病：\n\n{content[:3000]}"
            elif command == "summarize":
                user_msg = f"请概括以下内容：\n\n{content[:3000]}"
            else:
                user_msg = content[:3000]

            messages = build_messages(command, user_msg)
            async for chunk in await call_siliconflow(messages, stream=True, model=data.model):
                yield f"data: {json.dumps({'type': 'token', 'data': {'text': chunk}})}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'data': {}})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'data': {'message': _extract_ai_error(e)}})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/outline")
async def ai_generate_outline(
    data: AiGenerateOutlineRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI生成大纲"""
    await verify_book_access(data.book_id, current_user.id, db)

    try:
        user_msg = f"小说标题：{data.title}\n"
        if data.genre:
            user_msg += f"题材：{data.genre}\n"
        user_msg += f"章节数：{data.chapter_count}\n"
        if data.existing_outline:
            user_msg += f"现有大纲：{data.existing_outline}\n"
        user_msg += "\n请为我生成详细的小说大纲。"

        messages = build_messages("outline", user_msg)
        result = await call_siliconflow(messages, stream=False, model=data.model)
        return {"data": result}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"AI 服务调用失败: {str(e)}")
