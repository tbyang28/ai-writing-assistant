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
from app.schemas.ai import (
    AiChatRequest, AiWriteRequest, AiGenerateOutlineRequest,
    AiPolishDiffRequest, AiExtractCharactersRequest, AiResponse,
)
from app.services.ai_service import (
    call_siliconflow, build_messages, build_text_diff,
    summarize_diff, parse_character_extraction,
)
from app.services.rag_service import build_rag_context, index_chapter


def _extract_ai_error(e: Exception) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        try:
            body = e.response.json()
            msg = (
                body.get("message")
                or body.get("detail")
                or body.get("error", {}).get("message")
                or str(e)
            )
            if "insufficient" in msg.lower() or "余额" in msg:
                return "SiliconFlow 账户余额不足，请充值后重试"
            if e.response.status_code in (401, 403):
                return "SiliconFlow API Key 无效或没有权限，请检查 Render 后端环境变量 SILICONFLOW_API_KEY"
            return f"AI 服务错误 ({e.response.status_code}): {msg}"
        except Exception:
            pass
    return f"AI 服务调用失败: {str(e)}"


async def _get_previous_chapters(chapter_id: str, db: AsyncSession, limit: int = 2) -> list[Chapter]:
    """获取当前章节前面的历史章节（按 order 排序）"""
    # 先查当前章节的 order
    result = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
    current = result.scalar_one_or_none()
    if not current:
        return []

    # 查同一本书中 order 更小的章节（最新几条）
    result = await db.execute(
        select(Chapter)
        .where(Chapter.book_id == current.book_id, Chapter.order < current.order)
        .order_by(Chapter.order.desc())
        .limit(limit)
    )
    prev = list(result.scalars().all())
    prev.reverse()  # 按时间正序
    return prev


def _build_continue_prompt(content: str, rag_context: str, prev_chapters: list[Chapter]) -> str:
    """构建续写 prompt，带上历史章节作为上下文"""
    parts = []

    if prev_chapters:
        history_parts = []
        for ch in prev_chapters:
            # 取每章末尾 1500 字作为上下文（开头可能意义不大）
            tail = ch.content[-1500:] if len(ch.content) > 1500 else ch.content
            history_parts.append(f"【{ch.title}】\n{tail}")
        parts.append("【前情提要——以下是小说的历史章节内容】\n" + "\n\n".join(history_parts))

    if rag_context:
        parts.append(rag_context)

    parts.append("【当前章节内容，请基于前情续写】\n" + content[:3000])

    return "\n\n".join(parts)

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
            # 取历史章节上下文
            prev_chapters = []
            if data.chapter_id:
                prev_chapters = await _get_previous_chapters(data.chapter_id, db)
            # RAG: 搜索全书中与当前内容相关的段落作为背景
            rag_context = await build_rag_context(db, content[:1000], data.book_id)
            user_msg = _build_continue_prompt(content, rag_context, prev_chapters)
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
                # 取历史章节上下文
                prev_chapters = []
                if data.chapter_id:
                    prev_chapters = await _get_previous_chapters(data.chapter_id, db)
                # RAG: 搜索全书中与当前内容相关的段落作为背景
                rag_context = await build_rag_context(db, content[:1000], data.book_id)
                user_msg = _build_continue_prompt(content, rag_context, prev_chapters)
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


@router.post("/polish-diff")
async def ai_polish_diff(
    data: AiPolishDiffRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI 润色并返回可审阅的 diff 对比。"""
    await verify_book_access(data.book_id, current_user.id, db)

    original = (data.selected_text or data.content or "").strip()
    if not original:
        raise HTTPException(status_code=400, detail="需要提供待润色文本")

    try:
        user_msg = f"请润色以下小说片段，只输出润色后的正文：\n\n{original[:3000]}"
        messages = build_messages("polish_diff", user_msg)
        result = await call_siliconflow(messages, stream=False, model=data.model)
        revised = (result.get("answer") or "").strip()
        segments = build_text_diff(original, revised)

        return {
            "data": {
                "original": original,
                "revised": revised,
                "segments": segments,
                "summary": summarize_diff(segments),
            }
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=_extract_ai_error(e))


@router.post("/extract-characters")
async def ai_extract_characters(
    data: AiExtractCharactersRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """从小说正文中识别人物候选，不直接写入角色库。"""
    await verify_book_access(data.book_id, current_user.id, db)

    content = (data.content or "").strip()
    if len(content) < 20:
        raise HTTPException(status_code=400, detail="正文内容太短，无法识别人物")

    try:
        user_msg = f"请从以下小说正文中识别人物：\n\n{content[:6000]}"
        messages = build_messages("extract_characters", user_msg)
        result = await call_siliconflow(messages, stream=False, model=data.model)
        raw_answer = result.get("answer") or "{}"
        characters = parse_character_extraction(raw_answer)
        return {"data": {"characters": characters}}
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI 返回格式无法解析，请重试")
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=_extract_ai_error(e))


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
