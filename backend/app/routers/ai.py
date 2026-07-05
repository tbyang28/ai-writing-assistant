from __future__ import annotations

import json
import traceback

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.dependencies import get_current_user
from app.models import User, Book, Chapter, Character, Outline
from app.schemas.ai import (
    AiChatRequest, AiWriteRequest, AiGenerateOutlineRequest,
    AiPolishDiffRequest, AiExtractCharactersRequest, AiResponse,
)
from app.services.ai_service import (
    call_siliconflow, build_messages, build_text_diff,
    summarize_diff, parse_character_extraction,
    estimate_polish_diff_max_tokens,
)
from app.services.rag_service import build_rag_context


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


async def _get_current_chapter(chapter_id: str | None, db: AsyncSession) -> Chapter | None:
    if not chapter_id:
        return None
    result = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
    return result.scalar_one_or_none()


async def _get_recent_book_chapters(
    book_id: str,
    db: AsyncSession,
    current_chapter: Chapter | None = None,
    limit: int = 3,
) -> list[Chapter]:
    if limit <= 0:
        return []

    query = select(Chapter).where(Chapter.book_id == book_id)
    if current_chapter:
        query = query.where(Chapter.order < current_chapter.order)

    result = await db.execute(
        query
        .order_by(Chapter.order.desc())
        .limit(limit)
    )
    chapters = list(result.scalars().all())
    chapters.reverse()
    return chapters


async def _build_story_memory(
    db: AsyncSession,
    book: Book,
    query: str,
    chapter_id: str | None = None,
    current_content: str | None = None,
    *,
    previous_chapter_limit: int = 3,
    previous_chapter_chars: int = 1600,
    character_limit: int = 12,
    outline_limit: int = 8,
    current_chars: int = 3000,
    include_rag: bool = True,
) -> str:
    """Build a compact same-book memory block for AI calls."""
    current_chapter = await _get_current_chapter(chapter_id, db)
    previous_chapters = await _get_recent_book_chapters(
        book.id,
        db,
        current_chapter,
        previous_chapter_limit,
    )

    character_result = await db.execute(
        select(Character)
        .where(Character.book_id == book.id)
        .order_by(Character.created_at.asc())
        .limit(character_limit)
    )
    characters = list(character_result.scalars().all())

    outline_result = await db.execute(
        select(Outline)
        .where(Outline.book_id == book.id)
        .order_by(Outline.order.asc())
        .limit(outline_limit)
    )
    outlines = list(outline_result.scalars().all())

    rag_context = ""
    if include_rag and query.strip():
        try:
            rag_context = await build_rag_context(db, query[:1000], book.id)
        except Exception:
            rag_context = ""

    parts = [
        "【作品记忆】",
        f"作品名：{book.title}",
    ]
    if book.description:
        parts.append(f"作品简介：{book.description[:500]}")

    if characters:
        character_lines = []
        for character in characters:
            role = f"（{character.role}）" if character.role else ""
            bio = f"：{character.bio[:120]}" if character.bio else ""
            character_lines.append(f"- {character.name}{role}{bio}")
        parts.append("【人物设定】\n" + "\n".join(character_lines))

    if outlines:
        outline_lines = [
            f"- {outline.title}：{outline.content[:180]}" if outline.content else f"- {outline.title}"
            for outline in outlines
        ]
        parts.append("【大纲/设定】\n" + "\n".join(outline_lines))

    if previous_chapters:
        history_parts = []
        for chapter in previous_chapters:
            text = (chapter.content or "").strip()
            if not text:
                continue
            tail = text[-previous_chapter_chars:] if len(text) > previous_chapter_chars else text
            history_parts.append(f"【{chapter.title}】\n{tail}")
        if history_parts:
            parts.append("【最近前文章节】\n" + "\n\n".join(history_parts))

    if rag_context:
        parts.append(rag_context)

    current = (current_content or "").strip()
    if current and current_chars > 0:
        parts.append("【当前章节草稿】\n" + current[:current_chars])

    parts.append("【使用要求】回答必须严格承接同一本书的前文、人物关系和当前章节，不要凭空换主角、换世界观或重开剧情。")
    return "\n\n".join(parts)


def _build_contextual_chat_prompt(message: str, story_memory: str) -> str:
    return f"{story_memory}\n\n【用户问题】\n{message}"


def _build_continue_prompt(content: str, story_memory: str) -> str:
    """构建续写 prompt，带上历史章节作为上下文"""
    current = content.strip()
    current_block = current[:3000] if current else "当前章节还没有正文，请根据前文章节自然开启下一章。"
    return (
        f"{story_memory}\n\n"
        "【续写任务】\n"
        "请直接续写当前章节。必须延续最近前文中的情节因果、人物状态、称呼和叙事视角；"
        "如果当前章节为空，就从上一章之后自然接下一章开头。不要总结，不要写大纲，不要解释。\n\n"
        f"【当前续写位置】\n{current_block}"
    )


async def _prepare_polish_diff_call(
    db: AsyncSession,
    book: Book,
    data: AiPolishDiffRequest,
) -> dict:
    original = (data.selected_text or data.content or "").strip()
    if not original:
        raise HTTPException(status_code=400, detail="需要提供待润色文本")

    original_for_ai = original[:3000]
    original_tail = original[3000:]
    instruction = (data.instruction or "在保留原意和剧情的基础上，让文字更自然、更有画面感。").strip()
    story_memory = await _build_story_memory(
        db,
        book,
        original_for_ai,
        data.chapter_id,
        data.content,
        previous_chapter_limit=1,
        previous_chapter_chars=600,
        character_limit=8,
        outline_limit=4,
        current_chars=800 if data.selected_text else 0,
        include_rag=False,
    )
    user_msg = (
        f"{story_memory}\n\n"
        "【AI 修改审阅任务】\n"
        "请根据用户要求修改待处理文本，只修改必要之处。只输出修改后的正文，不要解释、不要标题、不要列修改点。\n"
        "必须保留原文核心情节、人物关系、叙事视角和上下文一致性；不要新增与作品记忆冲突的设定。\n\n"
        f"【用户修改要求】\n{instruction}\n\n"
        f"【待处理文本】\n{original_for_ai}"
    )

    return {
        "messages": build_messages("polish_diff", user_msg),
        "instruction": instruction,
        "original_for_ai": original_for_ai,
        "original_tail": original_tail,
        "original_length": len(original),
        "processed_length": len(original_for_ai),
        "max_tokens": estimate_polish_diff_max_tokens(original_for_ai),
    }


def _build_polish_diff_response(call_data: dict, revised_for_ai: str) -> dict:
    revised_for_ai = revised_for_ai.strip()
    revised = revised_for_ai + call_data["original_tail"]
    segments = build_text_diff(call_data["original_for_ai"], revised_for_ai)

    return {
        "original": call_data["original_for_ai"],
        "revised": revised,
        "segments": segments,
        "summary": summarize_diff(segments),
        "instruction": call_data["instruction"],
        "truncated": bool(call_data["original_tail"]),
        "original_length": call_data["original_length"],
        "processed_length": call_data["processed_length"],
    }


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
    book = await verify_book_access(data.book_id, current_user.id, db)

    try:
        memory_query = data.current_content or data.message
        story_memory = await _build_story_memory(
            db,
            book,
            memory_query,
            data.chapter_id,
            data.current_content,
        )
        user_msg = _build_contextual_chat_prompt(data.message, story_memory)

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
    book = await verify_book_access(data.book_id, current_user.id, db)

    async def generate():
        try:
            memory_query = data.current_content or data.message
            story_memory = await _build_story_memory(
                db,
                book,
                memory_query,
                data.chapter_id,
                data.current_content,
            )
            user_msg = _build_contextual_chat_prompt(data.message, story_memory)

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
    book = await verify_book_access(data.book_id, current_user.id, db)

    try:
        command = data.command
        content = data.selected_text or data.content

        if command == "continue":
            story_memory = await _build_story_memory(
                db,
                book,
                content,
                data.chapter_id,
                data.content,
            )
            user_msg = _build_continue_prompt(content, story_memory)
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
    book = await verify_book_access(data.book_id, current_user.id, db)

    async def generate():
        try:
            command = data.command
            content = data.selected_text or data.content

            if command == "continue":
                story_memory = await _build_story_memory(
                    db,
                    book,
                    content,
                    data.chapter_id,
                    data.content,
                )
                user_msg = _build_continue_prompt(content, story_memory)
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
    book = await verify_book_access(data.book_id, current_user.id, db)
    if not (data.selected_text or data.content or "").strip():
        raise HTTPException(status_code=400, detail="需要提供待润色文本")

    try:
        call_data = await _prepare_polish_diff_call(db, book, data)
        result = await call_siliconflow(
            call_data["messages"],
            stream=False,
            model=data.model,
            max_tokens=call_data["max_tokens"],
            temperature=0.35,
        )

        return {
            "data": _build_polish_diff_response(
                call_data,
                result.get("answer") or "",
            )
        }
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=_extract_ai_error(e))


@router.post("/polish-diff/stream")
async def ai_polish_diff_stream(
    data: AiPolishDiffRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI 润色流式返回正文 token，完成后返回 diff 审阅结果。"""
    book = await verify_book_access(data.book_id, current_user.id, db)
    if not (data.selected_text or data.content or "").strip():
        raise HTTPException(status_code=400, detail="需要提供待润色文本")

    async def generate():
        try:
            call_data = await _prepare_polish_diff_call(db, book, data)
            meta = {
                "original": call_data["original_for_ai"],
                "instruction": call_data["instruction"],
                "truncated": bool(call_data["original_tail"]),
                "original_length": call_data["original_length"],
                "processed_length": call_data["processed_length"],
            }
            yield f"data: {json.dumps({'type': 'meta', 'data': meta})}\n\n"

            revised_chunks: list[str] = []
            async for chunk in await call_siliconflow(
                call_data["messages"],
                stream=True,
                model=data.model,
                max_tokens=call_data["max_tokens"],
                temperature=0.35,
            ):
                revised_chunks.append(chunk)
                yield f"data: {json.dumps({'type': 'token', 'data': {'text': chunk}})}\n\n"

            payload = _build_polish_diff_response(call_data, "".join(revised_chunks))
            yield f"data: {json.dumps({'type': 'result', 'data': payload})}\n\n"
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
