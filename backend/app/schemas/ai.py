from pydantic import BaseModel
from typing import Optional, List


class AiChatRequest(BaseModel):
    book_id: str
    message: str
    chapter_id: Optional[str] = None
    current_content: Optional[str] = None
    history: Optional[List[dict]] = None
    model: Optional[str] = None  # SiliconFlow model ID, None = use default


class AiWriteRequest(BaseModel):
    book_id: str
    content: str
    command: str  # continue | improve | fix | summarize
    chapter_id: Optional[str] = None
    selected_text: Optional[str] = None
    model: Optional[str] = None  # SiliconFlow model ID, None = use default


class AiGenerateOutlineRequest(BaseModel):
    book_id: str
    title: str
    genre: Optional[str] = None
    chapter_count: Optional[int] = 5
    existing_outline: Optional[str] = None
    model: Optional[str] = None  # SiliconFlow model ID, None = use default


class AiPolishDiffRequest(BaseModel):
    book_id: str
    content: str
    chapter_id: Optional[str] = None
    selected_text: Optional[str] = None
    instruction: Optional[str] = None
    model: Optional[str] = None  # SiliconFlow model ID, None = use default


class AiExtractCharactersRequest(BaseModel):
    book_id: str
    content: str
    chapter_id: Optional[str] = None
    model: Optional[str] = None  # SiliconFlow model ID, None = use default


class AiResponse(BaseModel):
    answer: Optional[str] = None
    suggestion: Optional[str] = None
    suggestions: Optional[List[str]] = None
