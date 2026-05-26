from __future__ import annotations

import json
from typing import AsyncGenerator

import httpx

from app.config import settings

# 共享 httpx 客户端，复用连接池，减少 TCP 握手开销
_client: httpx.AsyncClient | None = None


async def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(180.0, connect=15.0),
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
            proxies={},  # 禁用代理，避免代理导致的连接问题
        )
    return _client


async def close_client():
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


SYSTEM_PROMPTS = {
    "chat": """你是一个专业的网文写作助手。你可以：
1. 回答关于写作技巧、情节设计、角色塑造等问题
2. 提供创作建议和改进方案
3. 帮助作者拓展思路、完善剧情

请用中文回答，语气友好专业，给出具体可操作的建议。""",

    "continue": """你是一个网文续写助手。根据已有的内容，自然地延续故事情节。
要求：
1. 保持原有风格和视角
2. 情节发展合理自然
3. 语言流畅，有画面感
4. 只输出续写的小说内容本身，不要任何分析、解释、前缀说明，直接输出文字""",

    "improve": """你是一个网文润色助手。对以下文本进行润色优化。
要求：
1. 保持原意和核心情节不变
2. 优化表达，使语言更生动
3. 修正语病和不自然的表达
4. 只输出润色后的小说内容本身，不要任何分析、修改说明、前缀后缀，直接输出文字""",

    "fix": """你是一个网文校对助手。修正以下文本中的错别字、语法错误和标点问题。
要求：
1. 只修正错误，不改变原意和风格
2. 只输出修正后的小说内容本身，不要任何前缀说明，直接输出文字""",

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
}


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
