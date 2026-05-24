"""
RAG (Retrieval-Augmented Generation) 服务

原理：
  1. 把全书内容切成小段，每段转成向量（一串数字）存起来
  2. 用户写新内容时，把当前内容转成向量
  3. 找"意思最接近"的历史段落（不靠关键词，靠向量距离）
  4. 把这些段落作为上下文塞给 AI

为什么不用关键词搜索？
  - 搜索"剑客"搜不到"侠客" → 但向量搜索能，因为它们的语义向量距离近
  - 搜索"他受伤了"搜不到"胸口一阵剧痛" → 向量搜索能
"""

import json
from typing import List

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import DocumentChunk
from app.services.ai_service import get_client

# 每段文本切多大（字符数）
CHUNK_SIZE = 500
# 段与段之间重叠多少字符（防止关键信息被切在边界）
CHUNK_OVERLAP = 100
# 每次搜索返回几段
TOP_K = 5


async def embed_text(text: str) -> List[float]:
    """把一段文本转成向量 —— 调用 SiliconFlow 的 Embedding API

    原理：Embedding 模型把"张三是个剑客"变成 [0.027, -0.021, ...]（1024 个数字）
    意思相近的句子，向量也相近。
    """
    client = await get_client()
    response = await client.post(
        f"{settings.siliconflow_base_url}/embeddings",
        headers={
            "Authorization": f"Bearer {settings.siliconflow_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": "BAAI/bge-large-zh-v1.5",
            "input": [text],
        },
    )
    response.raise_for_status()
    data = response.json()
    return data["data"][0]["embedding"]


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """计算两个向量的余弦相似度 —— 值越接近 1 表示意思越相近

    公式：cos(θ) = (A·B) / (|A| * |B|)
    形象理解：两个向量在空间中的夹角越小，相似度越高
    """
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    return dot / (norm_a * norm_b) if norm_a * norm_b > 0 else 0


def split_into_chunks(text: str) -> List[str]:
    """把长文本切成短段，段与段之间有一定重叠

    为什么要重叠？
      假设 500 字处分段："张三拔出长剑。/ 李四转身就跑。"
      如果正好切在"/"这里，"李四转身就跑"这段就没了前半句的上下文
      重叠 100 字确保关键信息不会正好断在边界
    """
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks if chunks else [text]


async def index_chapter(db: AsyncSession, chapter_id: str, content: str, book_id: str):
    """把一章内容切段 → 向量化 → 存入数据库

    什么时候调用：每次保存章节时（在 autoSave 里触发）
    """
    # 删除该章旧的索引
    old = await db.execute(
        select(DocumentChunk).where(DocumentChunk.chapter_id == chapter_id)
    )
    for row in old.scalars():
        await db.delete(row)

    # 切段
    chunks = split_into_chunks(content)

    for i, chunk_text in enumerate(chunks):
        if not chunk_text.strip():
            continue
        try:
            # 向量化
            vec = await embed_text(chunk_text)
        except Exception:
            # 向量化失败不阻塞保存，跳过后续索引
            continue
        # 存入数据库
        doc = DocumentChunk(
            book_id=book_id,
            chapter_id=chapter_id,
            content=chunk_text,
            chunk_order=i,
            embedding=json.dumps(vec),  # 向量转成 JSON 字符串存
        )
        db.add(doc)

    await db.commit()


async def search_similar(
    db: AsyncSession,
    query: str,
    book_id: str,
    top_k: int = TOP_K,
) -> List[dict]:
    """语义搜索：给定一段文字，找全书中意思最相近的段落

    流程：
      1. 把 query（用户当前写的内容）转成向量
      2. 从数据库取出本书所有段的向量
      3. 逐个计算相似度
      4. 返回最相似的 top_k 段

    注意：这里是在 Python 里暴力计算，数据量大时性能差。
    真正的工业级方案会用向量数据库（如 Chroma、Pinecone、Milvus）。
    但咱这个项目数据量小，Python 算够了。
    """
    # 把 query 转成向量
    query_vec = await embed_text(query)

    # 取出本书所有段
    result = await db.execute(
        select(DocumentChunk).where(DocumentChunk.book_id == book_id)
    )
    chunks = result.scalars().all()

    # 逐个算相似度
    scored = []
    for chunk in chunks:
        if not chunk.embedding:
            continue
        chunk_vec = json.loads(chunk.embedding)
        score = cosine_similarity(query_vec, chunk_vec)
        scored.append((score, chunk.content))

    # 按相似度从高到低排序
    scored.sort(key=lambda x: x[0], reverse=True)

    # 返回最相似的 top_k 段
    return [
        {"content": content, "score": round(score, 4)}
        for score, content in scored[:top_k]
    ]


async def build_rag_context(
    db: AsyncSession,
    query: str,
    book_id: str,
) -> str:
    """构建 RAG 上下文文本 —— 拼成一段文字塞进 prompt

    效果：
      [相关背景]
      张三是个剑客，在青云山上练剑十年。
      李四是魔教教主，与张三有杀父之仇。
      ...
      [/相关背景]
    """
    results = await search_similar(db, query, book_id)

    if not results:
        return ""

    lines = ["[相关背景]"]
    for r in results:
        lines.append(r["content"])
    lines.append("[/相关背景]")
    return "\n".join(lines)
