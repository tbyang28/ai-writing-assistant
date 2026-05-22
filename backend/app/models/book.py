import uuid
from datetime import datetime

from sqlalchemy import Column, String, Integer, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship

from app.database import Base


def gen_uuid():
    return str(uuid.uuid4())


class Book(Base):
    __tablename__ = "books"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, nullable=False)
    cover = Column(String, default="")
    description = Column(Text, default="")
    status = Column(String, default="DRAFT")  # DRAFT | SERIAL | FINISHED
    word_count = Column(Integer, default=0)
    owner_id = Column(String, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner = relationship("User", back_populates="books")
    chapters = relationship("Chapter", back_populates="book", cascade="all, delete-orphan",
                            order_by="Chapter.order")
    outlines = relationship("Outline", back_populates="book", cascade="all, delete-orphan",
                            order_by="Outline.order")
    characters = relationship("Character", back_populates="book", cascade="all, delete-orphan")
    inspirations = relationship("Inspiration", back_populates="book", cascade="all, delete-orphan")


class Chapter(Base):
    __tablename__ = "chapters"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, default="未命名章节")
    content = Column(Text, default="")
    word_count = Column(Integer, default=0)
    status = Column(String, default="DRAFT")  # DRAFT | PUBLISHED
    order = Column(Integer, default=0)
    book_id = Column(String, ForeignKey("books.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    book = relationship("Book", back_populates="chapters")


class Outline(Base):
    __tablename__ = "outlines"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, nullable=False)
    content = Column(Text, default="")
    order = Column(Integer, default=0)
    book_id = Column(String, ForeignKey("books.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    book = relationship("Book", back_populates="outlines")


class Character(Base):
    __tablename__ = "characters"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    role = Column(String, default="")
    avatar = Column(String, default="")
    bio = Column(Text, default="")
    book_id = Column(String, ForeignKey("books.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    book = relationship("Book", back_populates="characters")


class Inspiration(Base):
    __tablename__ = "inspirations"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    tags = Column(String, default="[]")  # JSON array as string
    book_id = Column(String, ForeignKey("books.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    book = relationship("Book", back_populates="inspirations")
