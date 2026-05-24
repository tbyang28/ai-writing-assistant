import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, Integer, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from app.database import Base


def gen_uuid():
    return str(uuid.uuid4())


class DocumentChunk(Base):
    """存储文本块及其向量嵌入"""
    __tablename__ = "document_chunks"

    id = Column(String, primary_key=True, default=gen_uuid)
    book_id = Column(String, ForeignKey("books.id"), nullable=False, index=True)
    chapter_id = Column(String, ForeignKey("chapters.id"), nullable=True)
    # 文本块的内容
    content = Column(Text, nullable=False)
    # 文本块序号（在同一本书中的顺序）
    chunk_order = Column(Integer, default=0)
    # 向量嵌入，存为 JSON 字符串
    embedding = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    book = relationship("Book", backref="chunks")
