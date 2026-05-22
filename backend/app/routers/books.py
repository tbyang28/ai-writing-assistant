import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.dependencies import get_current_user
from app.models import User, Book, Chapter, Outline, Character, Inspiration
from app.schemas.book import (
    BookCreate, BookUpdate, BookListResponse, BookResponse, BookStats,
    ChapterCreate, ChapterUpdate, ChapterSave, ChapterResponse,
    OutlineCreate, OutlineResponse,
    CharacterCreate, CharacterResponse,
    InspirationCreate, InspirationResponse,
    WritingStatsResponse,
)

router = APIRouter(prefix="/api", tags=["books"])


# ===================== Books =====================

@router.get("/books", response_model=list[BookListResponse])
async def list_books(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Book).where(Book.owner_id == current_user.id).order_by(Book.updated_at.desc())
    )
    books = result.scalars().all()
    return [BookListResponse.model_validate(b) for b in books]


@router.get("/books/stats", response_model=BookStats)
async def book_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Book).where(Book.owner_id == current_user.id)
    )
    books = result.scalars().all()
    total_books = len(books)
    total_words = sum(b.word_count for b in books)
    total_chapters = 0
    serial_books = sum(1 for b in books if b.status == "SERIAL")
    finished_books = sum(1 for b in books if b.status == "FINISHED")

    for book in books:
        ch_result = await db.execute(
            select(func.count()).select_from(Chapter).where(Chapter.book_id == book.id)
        )
        total_chapters += ch_result.scalar() or 0

    return BookStats(
        totalBooks=total_books,
        totalWords=total_words,
        totalChapters=total_chapters,
        serialBooks=serial_books,
        finishedBooks=finished_books,
    )


@router.get("/stats", response_model=WritingStatsResponse)
async def writing_stats(
    days: int = 7,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 计算今日字数（通过最新更新章节的word_count估算）
    today = date.today()
    today_start = datetime(today.year, today.month, today.day)
    today_end = today_start + timedelta(days=1)

    result = await db.execute(
        select(Book).where(Book.owner_id == current_user.id)
    )
    books = result.scalars().all()

    total_word_count = sum(b.word_count for b in books)
    today_word_count = 0

    for book in books:
        ch_result = await db.execute(
            select(Chapter).where(
                Chapter.book_id == book.id,
                Chapter.updated_at >= today_start,
                Chapter.updated_at < today_end,
            )
        )
        today_chapters = ch_result.scalars().all()
        today_word_count += sum(c.word_count for c in today_chapters)

    # 计算连续天数（简化：按书最后更新时间估算）
    streak_days = 0
    check_date = today
    while True:
        found = False
        for book in books:
            if book.updated_at and book.updated_at.date() == check_date:
                found = True
                break
        if found:
            streak_days += 1
            check_date -= timedelta(days=1)
        else:
            break

    # 最近7天数据
    last_7_days = []
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        day_start = datetime(d.year, d.month, d.day)
        day_end = day_start + timedelta(days=1)
        wc = 0
        for book in books:
            ch_result = await db.execute(
                select(Chapter).where(
                    Chapter.book_id == book.id,
                    Chapter.updated_at >= day_start,
                    Chapter.updated_at < day_end,
                )
            )
            wc += sum(c.word_count for c in ch_result.scalars().all())
        last_7_days.append({"date": d.isoformat(), "wordCount": wc})

    return WritingStatsResponse(
        today_word_count=today_word_count,
        total_word_count=total_word_count,
        streak_days=streak_days,
        active_days=streak_days,
        last_7_days=last_7_days,
        today=today.isoformat(),
    )


@router.get("/books/{book_id}", response_model=BookResponse)
async def get_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Book)
        .options(
            selectinload(Book.chapters),
            selectinload(Book.outlines),
            selectinload(Book.characters),
            selectinload(Book.inspirations),
        )
        .where(Book.id == book_id, Book.owner_id == current_user.id)
    )
    book = result.unique().scalar_one_or_none()
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="作品不存在")

    return BookResponse(
        id=book.id, title=book.title, cover=book.cover,
        description=book.description, status=book.status,
        word_count=book.word_count, owner_id=book.owner_id,
        created_at=book.created_at, updated_at=book.updated_at,
        chapters=[ChapterResponse.model_validate(c) for c in (book.chapters or [])],
        outlines=[OutlineResponse.model_validate(o) for o in (book.outlines or [])],
        characters=[CharacterResponse.model_validate(c) for c in (book.characters or [])],
        inspirations=[InspirationResponse.model_validate(i) for i in (book.inspirations or [])],
    )


@router.post("/books", response_model=BookListResponse, status_code=status.HTTP_201_CREATED)
async def create_book(
    data: BookCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = Book(
        title=data.title,
        description=data.description or "",
        cover=data.cover or "",
        owner_id=current_user.id,
    )
    db.add(book)
    await db.commit()
    await db.refresh(book)
    return BookListResponse.model_validate(book)


@router.put("/books/{book_id}", response_model=BookListResponse)
async def update_book(
    book_id: str,
    data: BookUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Book).where(Book.id == book_id, Book.owner_id == current_user.id)
    )
    book = result.scalar_one_or_none()
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="作品不存在")

    if data.title is not None:
        book.title = data.title
    if data.description is not None:
        book.description = data.description
    if data.cover is not None:
        book.cover = data.cover
    if data.status is not None:
        book.status = data.status

    await db.commit()
    await db.refresh(book)
    return BookResponse.model_validate(book)


@router.delete("/books/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_book(
    book_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Book).where(Book.id == book_id, Book.owner_id == current_user.id)
    )
    book = result.scalar_one_or_none()
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="作品不存在")

    await db.delete(book)
    await db.commit()


# ===================== Chapters =====================

@router.post("/books/{book_id}/chapters", response_model=ChapterResponse, status_code=status.HTTP_201_CREATED)
async def create_chapter(
    book_id: str,
    data: ChapterCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Book).where(Book.id == book_id, Book.owner_id == current_user.id)
    )
    book = result.scalar_one_or_none()
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="作品不存在")

    max_order_result = await db.execute(
        select(func.max(Chapter.order)).where(Chapter.book_id == book_id)
    )
    max_order = max_order_result.scalar() or 0

    chapter = Chapter(
        title=data.title or "未命名章节",
        book_id=book_id,
        order=max_order + 1,
    )
    db.add(chapter)
    await db.commit()
    await db.refresh(chapter)
    return ChapterResponse.model_validate(chapter)


@router.get("/chapters/{chapter_id}", response_model=ChapterResponse)
async def get_chapter(
    chapter_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Chapter).join(Book).where(
            Chapter.id == chapter_id,
            Book.owner_id == current_user.id,
        )
    )
    chapter = result.scalar_one_or_none()
    if not chapter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="章节不存在")
    return ChapterResponse.model_validate(chapter)


@router.put("/chapters/save", response_model=ChapterResponse)
async def save_chapter(
    data: ChapterSave,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Chapter).join(Book).where(
            Chapter.id == data.chapter_id,
            Book.owner_id == current_user.id,
        )
    )
    chapter = result.scalar_one_or_none()
    if not chapter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="章节不存在")

    if data.title is not None:
        chapter.title = data.title
    if data.content is not None:
        chapter.content = data.content
        chapter.word_count = len(data.content.replace(" ", "").replace("\n", ""))

    # 更新书籍总字数
    book_result = await db.execute(select(Book).where(Book.id == chapter.book_id))
    book = book_result.scalar_one()
    ch_result = await db.execute(
        select(func.sum(Chapter.word_count)).where(Chapter.book_id == chapter.book_id)
    )
    total = ch_result.scalar() or 0
    book.word_count = total

    await db.commit()
    await db.refresh(chapter)
    return ChapterResponse.model_validate(chapter)


@router.put("/books/{book_id}/chapters/{chapter_id}", response_model=ChapterResponse)
async def update_chapter(
    book_id: str,
    chapter_id: str,
    data: ChapterUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Chapter).join(Book).where(
            Chapter.id == chapter_id,
            Chapter.book_id == book_id,
            Book.owner_id == current_user.id,
        )
    )
    chapter = result.scalar_one_or_none()
    if not chapter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="章节不存在")

    if data.title is not None:
        chapter.title = data.title
    if data.status is not None:
        chapter.status = data.status

    await db.commit()
    await db.refresh(chapter)
    return ChapterResponse.model_validate(chapter)


@router.delete("/books/{book_id}/chapters/{chapter_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_chapter(
    book_id: str,
    chapter_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Chapter).join(Book).where(
            Chapter.id == chapter_id,
            Chapter.book_id == book_id,
            Book.owner_id == current_user.id,
        )
    )
    chapter = result.scalar_one_or_none()
    if not chapter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="章节不存在")

    await db.delete(chapter)
    await db.commit()


@router.post("/chapters/publish", response_model=ChapterResponse)
async def publish_chapter(
    data: dict,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    chapter_id = data.get("chapter_id")
    result = await db.execute(
        select(Chapter).join(Book).where(
            Chapter.id == chapter_id,
            Book.owner_id == current_user.id,
        )
    )
    chapter = result.scalar_one_or_none()
    if not chapter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="章节不存在")

    chapter.status = "PUBLISHED"
    await db.commit()
    await db.refresh(chapter)
    return ChapterResponse.model_validate(chapter)


# ===================== Outlines =====================

@router.get("/books/{book_id}/outlines", response_model=list[OutlineResponse])
async def list_outlines(
    book_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Outline).join(Book).where(
            Outline.book_id == book_id,
            Book.owner_id == current_user.id,
        ).order_by(Outline.order)
    )
    return [OutlineResponse.model_validate(o) for o in result.scalars().all()]


@router.post("/books/{book_id}/outlines", response_model=OutlineResponse, status_code=status.HTTP_201_CREATED)
async def create_outline(
    book_id: str,
    data: OutlineCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    max_order = await db.execute(
        select(func.max(Outline.order)).where(Outline.book_id == book_id)
    )
    order = (max_order.scalar() or 0) + 1
    outline = Outline(
        title=data.title, content=data.content or "",
        book_id=book_id, order=order,
    )
    db.add(outline)
    await db.commit()
    await db.refresh(outline)
    return OutlineResponse.model_validate(outline)


# ===================== Characters =====================

@router.get("/books/{book_id}/characters", response_model=list[CharacterResponse])
async def list_characters(
    book_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Character).join(Book).where(
            Character.book_id == book_id,
            Book.owner_id == current_user.id,
        )
    )
    return [CharacterResponse.model_validate(c) for c in result.scalars().all()]


@router.post("/books/{book_id}/characters", response_model=CharacterResponse, status_code=status.HTTP_201_CREATED)
async def create_character(
    book_id: str,
    data: CharacterCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    character = Character(
        name=data.name, role=data.role or "", bio=data.bio or "",
        book_id=book_id,
    )
    db.add(character)
    await db.commit()
    await db.refresh(character)
    return CharacterResponse.model_validate(character)


# ===================== Inspirations =====================

@router.get("/books/{book_id}/inspirations", response_model=list[InspirationResponse])
async def list_inspirations(
    book_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Inspiration).join(Book).where(
            Inspiration.book_id == book_id,
            Book.owner_id == current_user.id,
        ).order_by(Inspiration.created_at.desc())
    )
    return [InspirationResponse.model_validate(i) for i in result.scalars().all()]


@router.post("/books/{book_id}/inspirations", response_model=InspirationResponse, status_code=status.HTTP_201_CREATED)
async def create_inspiration(
    book_id: str,
    data: InspirationCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    inspiration = Inspiration(
        title=data.title, content=data.content,
        tags=json.dumps(data.tags or []),
        book_id=book_id,
    )
    db.add(inspiration)
    await db.commit()
    await db.refresh(inspiration)
    return InspirationResponse.model_validate(inspiration)
