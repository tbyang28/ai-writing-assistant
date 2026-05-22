from pydantic import BaseModel
from typing import Optional, List


class AiChatRequest(BaseModel):
    book_id: str
    message: str
    chapter_id: Optional[str] = None
    current_content: Optional[str] = None
    history: Optional[List[dict]] = None


class AiWriteRequest(BaseModel):
    book_id: str
    content: str
    command: str  # continue | improve | fix | summarize
    chapter_id: Optional[str] = None
    selected_text: Optional[str] = None


class AiGenerateOutlineRequest(BaseModel):
    book_id: str
    title: str
    genre: Optional[str] = None
    chapter_count: Optional[int] = 5
    existing_outline: Optional[str] = None


class AiResponse(BaseModel):
    answer: Optional[str] = None
    suggestion: Optional[str] = None
    suggestions: Optional[List[str]] = None
