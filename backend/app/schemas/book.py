from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class BookCreate(BaseModel):
    title: str
    description: Optional[str] = None
    cover: Optional[str] = None


class BookUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    cover: Optional[str] = None
    status: Optional[str] = None


class BookStats(BaseModel):
    totalBooks: int = 0
    totalWords: int = 0
    totalChapters: int = 0
    serialBooks: int = 0
    finishedBooks: int = 0


class ChapterCreate(BaseModel):
    title: Optional[str] = "未命名章节"


class ChapterUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    status: Optional[str] = None


class ChapterSave(BaseModel):
    chapter_id: str
    title: Optional[str] = None
    content: Optional[str] = None


class ChapterResponse(BaseModel):
    id: str
    title: str
    content: str = ""
    word_count: int = 0
    status: str = "DRAFT"
    order: int = 0
    book_id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class OutlineCreate(BaseModel):
    title: str
    content: Optional[str] = None


class OutlineResponse(BaseModel):
    id: str
    title: str
    content: Optional[str] = None
    order: int = 0
    book_id: str

    class Config:
        from_attributes = True


class CharacterCreate(BaseModel):
    name: str
    role: Optional[str] = None
    bio: Optional[str] = None


class CharacterResponse(BaseModel):
    id: str
    name: str
    role: Optional[str] = None
    avatar: Optional[str] = None
    bio: Optional[str] = None
    book_id: str

    class Config:
        from_attributes = True


class CharacterRelationCreate(BaseModel):
    source_character_id: str
    target_character_id: str
    relation_type: str = "ally"
    description: Optional[str] = None
    strength: int = 2


class CharacterRelationResponse(BaseModel):
    id: str
    source_character_id: str
    target_character_id: str
    relation_type: str = "ally"
    description: Optional[str] = None
    strength: int = 2
    book_id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class InspirationCreate(BaseModel):
    title: str
    content: str
    tags: Optional[List[str]] = None


class InspirationResponse(BaseModel):
    id: str
    title: str
    content: str
    tags: str = "[]"
    book_id: str
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BookListResponse(BaseModel):
    id: str
    title: str
    cover: Optional[str] = None
    description: Optional[str] = None
    status: str = "DRAFT"
    word_count: int = 0
    owner_id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BookResponse(BookListResponse):
    chapters: Optional[List[ChapterResponse]] = None
    outlines: Optional[List[OutlineResponse]] = None
    characters: Optional[List[CharacterResponse]] = None
    character_relations: Optional[List[CharacterRelationResponse]] = None
    inspirations: Optional[List[InspirationResponse]] = None


class WritingStatsResponse(BaseModel):
    today_word_count: int = 0
    total_word_count: int = 0
    streak_days: int = 0
    active_days: int = 0
    last_7_days: List[dict] = []
    today: str = ""
