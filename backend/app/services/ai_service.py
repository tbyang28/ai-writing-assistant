from __future__ import annotations

import json
from difflib import SequenceMatcher
from typing import AsyncGenerator

import httpx

from app.config import settings

# 共享 httpx 客户端，复用连接池，减少 TCP 握手开销
_client: httpx.AsyncClient | None = None


async def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # 使用 HTTPTransport 禁用系统代理
        transport = httpx.AsyncHTTPTransport(
            retries=2,
        )
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(180.0, connect=15.0),
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
            transport=transport,
            trust_env=False,  # 禁用系统代理，避免代理导致 500
        )
    return _client


async def close_client():
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


SYSTEM_PROMPTS = {
    "chat": """你是一个专业的网文写作引擎。根据用户的问题提供帮助。

如果用户要求你写小说、续写、润色或校对——请直接输出小说正文本身，不要添加分析、建议、说明文字。

如果是回答写作相关问题，用中文回答，语气友好专业，给出具体可操作的建议。""",

    "continue": """你是小说续写引擎，不是聊天助手。你的唯一任务是输出续写的小说正文。

【硬性规定——违反任何一条将导致回答作废】
1. 只输出小说正文，不要对话、不要提问、不要建议
2. 禁止出现：后续章节建议、本章关键点、大纲、章节标题、括号注释
3. 禁止出现："我们可以这样写"、"下面继续"、"需要我如何调整"等任何与正文无关的语句
4. 禁止出现：冒号引导的说明文字、分析性句子、元评论
5. 续写的第一个字必须是小说正文的第一个字——没有前缀、没有引子、没有铺垫说明

记住：你是一个没有感情的码字机，你的输出就是小说的直接延续。""",

    "improve": """你是小说润色引擎，不是聊天助手。你的唯一任务是输出润色后的小说正文。

【硬性规定——违反任何一条将导致回答作废】
1. 只输出润色后的小说正文，不要对话、不要提问、不要建议
2. 禁止出现：修改说明、改动说明、润色说明、前后对比
3. 禁止出现："以下是润色后的内容"、"修改了以下地方"等元语句
4. 禁止出现：冒号引导的说明文字、括号注释、关键点总结
5. 输出的第一个字必须是正文的第一个字——没有前缀、没有引子、没有任何铺垫

记住：你是一个没有感情的润色器，输出即润色结果本身。""",

    "polish_diff": """你是小说润色引擎。你的唯一任务是输出润色后的小说正文。

要求：
1. 严格按用户要求修改，不要主动大范围改写
2. 保留原文核心情节、人物关系、叙事视角、语气和信息顺序
3. 只优化确有必要的病句、重复表达、节奏拖沓和不自然措辞
4. 不要扩写成新情节，不要新增设定，不要添加解释、标题、修改说明或前后对比
5. 只输出润色后的正文，输出的第一个字必须是正文第一个字""",

    "fix": """你是小说校对引擎。你的唯一任务是输出校对后的小说正文。

【硬性规定——违反任何一条将导致回答作废】
1. 只输出校对后的小说正文，不要输出任何额外的文字
2. 禁止出现：修改说明、错误列表、前后对比、括号标注
3. 输出的第一个字就是正文，没有前缀、没有说明、没有建议""",

    "summarize": """你是一个网文摘要助手。对以下内容进行简洁的概括。
要求：
1. 抓住核心情节和关键信息
2. 用简洁的语言表达
3. 只输出摘要内容本身，不要任何前缀说明，直接输出文字""",

    "outline": """你是一个网文大纲生成助手。根据用户提供的信息，生成详细的小说大纲。
大纲应包括：
1. 核心设定（世界观、主题）
2. 主要角色简介
3. 分章大纲（每章的核心情节）

请以清晰的格式输出。""",

    "extract_characters": """你是小说人物信息抽取引擎。请从用户提供的小说正文中识别明确出现的人物。

要求：
1. 只抽取人物，不要抽取地点、组织、功法、物品、章节标题
2. 如果出现称号和真名，优先使用真名；没有真名时才使用稳定称号
3. 根据上下文推断人物身份，例如：主角、反派、师父、同伴、配角、未知
4. 为每个人物生成一句简短简介，说明他/她在片段中的作用
5. 只输出 JSON，不要 Markdown，不要解释

JSON 格式：
{
  "characters": [
    {
      "name": "人物名",
      "role": "主角/反派/师父/同伴/配角/未知",
      "bio": "一句话简介",
      "confidence": 0.86
    }
  ]
}""",
}


def build_text_diff(original: str, revised: str) -> list[dict[str, str]]:
    """Build a compact character-level diff for Chinese prose."""
    matcher = SequenceMatcher(None, original, revised)
    segments: list[dict[str, str]] = []
    pending_old: list[str] = []
    pending_new: list[str] = []
    opcodes = matcher.get_opcodes()

    def flush_pending():
        if pending_old:
            segments.append({"type": "delete", "text": "".join(pending_old)})
            pending_old.clear()
        if pending_new:
            segments.append({"type": "insert", "text": "".join(pending_new)})
            pending_new.clear()

    for idx, (tag, i1, i2, j1, j2) in enumerate(opcodes):
        if tag == "equal":
            text = original[i1:i2]
            next_tag = opcodes[idx + 1][0] if idx + 1 < len(opcodes) else "equal"
            if (pending_old or pending_new) and 0 < len(text) <= 4 and next_tag != "equal":
                pending_old.append(text)
                pending_new.append(text)
            else:
                flush_pending()
                if text:
                    segments.append({"type": "equal", "text": text})
        elif tag == "delete":
            text = original[i1:i2]
            if text:
                pending_old.append(text)
        elif tag == "insert":
            text = revised[j1:j2]
            if text:
                pending_new.append(text)
        elif tag == "replace":
            old_text = original[i1:i2]
            new_text = revised[j1:j2]
            if old_text:
                pending_old.append(old_text)
            if new_text:
                pending_new.append(new_text)

    flush_pending()
    return segments


def summarize_diff(segments: list[dict[str, str]], limit: int = 6, excerpt_len: int = 48) -> list[str]:
    """Create short human-readable change summaries for the UI."""
    summaries: list[str] = []
    i = 0
    while i < len(segments) and len(summaries) < limit:
        current = segments[i]
        next_segment = segments[i + 1] if i + 1 < len(segments) else None

        if current["type"] == "delete" and next_segment and next_segment["type"] == "insert":
            old = current["text"].strip()
            new = next_segment["text"].strip()
            if old or new:
                summaries.append(f"将「{old[:excerpt_len]}」改为「{new[:excerpt_len]}」")
            i += 2
            continue

        if current["type"] == "delete":
            text = current["text"].strip()
            if text:
                summaries.append(f"删除「{text[:excerpt_len]}」")
        elif current["type"] == "insert":
            text = current["text"].strip()
            if text:
                summaries.append(f"新增「{text[:excerpt_len]}」")
        i += 1

    return summaries


def parse_character_extraction(raw_text: str) -> list[dict]:
    """Parse and normalize LLM character extraction JSON."""
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()

    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]

    data = json.loads(text)
    characters = data.get("characters", [])
    normalized = []
    seen = set()

    for item in characters:
        name = str(item.get("name", "")).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        normalized.append({
            "name": name[:30],
            "role": str(item.get("role") or "未知").strip()[:30],
            "bio": str(item.get("bio") or "").strip()[:160],
            "confidence": float(item.get("confidence") or 0.7),
        })

    return normalized[:12]


async def call_siliconflow(
    messages: list[dict],
    stream: bool = False,
    model: str | None = None,
) -> dict | AsyncGenerator[str, None]:
    """调用 SiliconFlow API

    Args:
        messages: 消息列表
        stream: 是否流式输出
        model: 模型 ID，为 None 时使用 settings.deepseek_model
    """
    if not settings.siliconflow_api_key:
        raise RuntimeError("Render 后端未配置 SILICONFLOW_API_KEY，无法调用 AI 服务")

    headers = {
        "Authorization": f"Bearer {settings.siliconflow_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model or settings.deepseek_model,
        "messages": messages,
        "stream": stream,
        "max_tokens": 4096,
        "temperature": 0.7,
    }

    if stream:
        return _stream_response(headers, payload)

    client = await get_client()
    response = await client.post(
        f"{settings.siliconflow_base_url}/chat/completions",
        headers=headers,
        json=payload,
    )
    response.raise_for_status()
    data = response.json()
    return {"answer": data["choices"][0]["message"]["content"]}


async def _stream_response(
    headers: dict,
    payload: dict,
) -> AsyncGenerator[str, None]:
    client = await get_client()
    async with client.stream(
        "POST",
        f"{settings.siliconflow_base_url}/chat/completions",
        headers=headers,
        json=payload,
    ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:]
                    if data_str.strip() == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                        delta = data["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue


def build_messages(system_key: str, user_content: str, history: list[dict] | None = None) -> list[dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPTS.get(system_key, SYSTEM_PROMPTS["chat"])}]

    if history:
        for msg in history[-10:]:  # 保留最近10条历史
            if msg.get("role") in ("user", "assistant"):
                messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": user_content})
    return messages
