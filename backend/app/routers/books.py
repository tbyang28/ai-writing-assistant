import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.dependencies import get_current_user
from app.models import User, Book, Chapter, Outline, Character, CharacterRelation, Inspiration
from app.services.rag_service import index_chapter
from app.schemas.book import (
    BookCreate, BookUpdate, BookListResponse, BookResponse, BookStats,
    ChapterCreate, ChapterUpdate, ChapterSave, ChapterResponse,
    OutlineCreate, OutlineResponse,
    CharacterCreate, CharacterResponse,
    CharacterRelationCreate, CharacterRelationResponse,
    InspirationCreate, InspirationResponse,
    WritingStatsResponse,
)

router = APIRouter(prefix="/api", tags=["books"])


DEMO_BOOK_TITLE = "雨巷边缘"
DEMO_DESCRIPTION = "一个普通新生在雨天入学，意外卷入校园旧案与人物关系网的现代悬疑成长故事。"
DEMO_CHAPTERS = [
    {
        "title": "入学",
        "content": """# 知足同学入学第一天

九月一日清晨，知足拖着两个沉甸甸的行李箱，站在北京交通大学的南门前。她仰起头，凝视着校门上那六个鎏金大字，深吸一口气，手心悄悄沁出薄汗。

“同学，需要帮忙吗？”一位戴眼镜的学长快步迎了上来。

“谢谢学长，我自己可以。”知足下意识攥紧箱杆。

“是新生吧？哪个学院的？”

“交通运输学院。”

“真巧，我也是！”学长眼睛一亮，不由分说便接过她左手边的箱子，“走吧，我带你去报到处。”

校园里挂满了迎新的横幅和彩旗，梧桐树荫下光影斑驳。知足跟在学长身后，看着周围一张张新鲜的面孔，有人兴奋地和父母合影，有人已经和新室友聊得火热。她低头翻了翻手机，妈妈发来消息：“到了吗？宿舍怎么样？”

她刚想回复，身后忽然传来一阵急促的脚步声。一个扎高马尾的女生抱着一摞文件袋从人群里挤出来，差点撞上她的行李箱。

“抱歉抱歉！”女生停住脚步，冲她眨了眨眼，“你也是运输学院新生？我是学姐，叫林知意，今天负责迎新。”

知足愣了一下：“我也叫知足。”

林知意笑了：“那太巧了，我们名字听起来像一家人。”

报到处前排起了长队。知足递上录取通知书时，志愿者从文件袋里抽出一张蓝色校园卡，却忽然皱了皱眉。

“你的档案袋好像缺了一页。”志愿者低声说。

学长和林知意同时看向她。知足心里一沉，她明明记得妈妈昨晚帮她确认过所有材料。

就在这时，一阵风穿过广场，把公告栏上的旧照片吹得哗啦作响。知足无意间抬头，看见照片角落里有一个熟悉的名字：陈默。

那是她从未见过，却在家中旧信里出现过无数次的名字。""",
    },
    {
        "title": "旧照片",
        "content": """# 公告栏上的旧照片

午后的校园被阳光晒得发亮，知足抱着补办材料从学院楼出来，脑子里仍盘旋着“陈默”两个字。

林知意追上来，把一瓶冰水塞进她手里：“别太紧张，档案缺页这种事不算少见。你先去宿舍放东西，下午我陪你去档案室查。”

“学姐，你认识陈默吗？”知足问。

林知意脚步一顿，脸上的笑意淡了些：“你从哪里听到这个名字的？”

知足指了指远处的公告栏：“照片上看到的。”

公告栏里贴着一张十年前的社团合影。照片边缘发黄，站在最中间的年轻男人穿着白衬衫，眉眼温和，胸牌上写着“陈默”。旁边还有一个女生，侧脸和知足有几分相似。

“那是十年前学生会的人。”林知意压低声音，“听说后来出了点事，学校很少再提。”

“什么事？”

“我也只是听说。”林知意看向四周，“如果你真想知道，晚上去图书馆三层。那里有旧校刊合订本。”

黄昏时，知足按约定来到图书馆。三层靠窗的阅览区很安静，只有翻书声和空调声交织在一起。她在旧报刊架前找到十年前的校刊，翻到迎新专题时，手指忽然停住。

那张合影下方写着一行小字：陈默，交通运输学院学生会主席，于当年九月失踪。

与此同时，书架另一侧传来轻微的响动。知足猛地抬头，看见一个黑衣男生正站在阴影里，目光冷淡地看着她。

“别查这件事。”他说。

“你是谁？”

“周临。”男生把一本旧校刊推回架上，“如果不想惹麻烦，就离陈默远一点。”""",
    },
    {
        "title": "雨夜短信",
        "content": """# 雨夜短信

夜里十点，校园忽然下起大雨。知足坐在宿舍床边，盯着手机上那条陌生短信。

“你和她太像了。别相信学生会的人。”

发信号码没有备注，回拨过去只有冰冷的忙音。室友已经睡下，窗外雨声越来越急，像有人不断敲打玻璃。

她翻出家里的旧信。母亲从不愿多谈大学时代，只说自己年轻时认识过一个很重要的朋友。信纸泛黄，落款处的名字却清晰得刺眼：陈默。

门外传来轻轻的敲门声。

知足屏住呼吸。这个时间，宿舍楼早已门禁，谁会来找她？

“知足，是我。”门外响起林知意的声音，“你是不是收到短信了？”

知足打开门，林知意浑身湿透，手里攥着一个密封文件袋。

“档案室今晚被人翻过。”林知意把文件袋递给她，“我只抢出来这个。”

文件袋里是一张复印件。上面写着陈默失踪前最后一份申请：调取南门监控录像。

申请理由只有一句话：我怀疑迎新当天有人替换了新生档案。

知足心里一凉。她的档案，也是在迎新当天发现缺页的。

手机再次亮起，陌生号码发来第二条短信：

“雨停之前，离开宿舍。周临在找你。”""",
    },
]
DEMO_CHARACTERS = [
    {"name": "知足", "role": "主角", "bio": "大一新生，在入学第一天独自报到，意外发现自己的档案缺页。"},
    {"name": "林知意", "role": "同伴", "bio": "负责迎新的学姐，主动帮助知足调查档案缺页事件。"},
    {"name": "周临", "role": "复杂", "bio": "神秘的黑衣男生，警告知足不要追查陈默的失踪。"},
    {"name": "陈默", "role": "关键人物", "bio": "十年前失踪的学生会主席，与知足母亲的旧事有关。"},
    {"name": "妈妈", "role": "亲属", "bio": "知足的母亲，似乎隐瞒了自己与陈默的大学往事。"},
    {"name": "学长", "role": "配角", "bio": "迎新现场帮助知足搬运行李的交通运输学院学长。"},
]
DEMO_RELATIONS = [
    ("知足", "林知意", "ally", "林知意帮助知足补办材料，并陪她调查档案问题。", 4),
    ("知足", "周临", "complex", "周临警告知足停止调查，但似乎掌握关键线索。", 3),
    ("知足", "陈默", "complex", "知足在旧照片和家书里发现陈默与自己家庭有关。", 4),
    ("知足", "妈妈", "ally", "母女关系亲近，但妈妈隐瞒了大学时代的旧事。", 3),
    ("陈默", "妈妈", "complex", "两人在十年前有重要交集，可能与失踪事件有关。", 5),
    ("林知意", "周临", "rival", "两人都知道陈默事件，却选择不同方式接近知足。", 3),
    ("学长", "知足", "ally", "迎新当天帮助知足完成报到。", 2),
]
DEMO_OUTLINE = """第一卷围绕知足入学当天的档案缺页展开。

1. 入学：知足发现自己的档案袋缺页，并在迎新公告栏上看到陈默的旧照片。
2. 旧照片：林知意带她查阅旧校刊，周临出现并警告她不要继续调查。
3. 雨夜短信：陌生短信提醒知足离开宿舍，陈默失踪案与十年前新生档案替换事件浮出水面。

主线目标：查清陈默失踪原因，确认知足母亲当年隐瞒的真相。
人物冲突：林知意倾向保护知足，周临倾向阻止调查，陈默与妈妈的旧关系推动悬疑升级。"""
DEMO_INSPIRATIONS = [
    {
        "title": "核心悬念",
        "content": "陈默失踪、档案缺页、知足母亲旧事三条线交织，后续可以让每条线索都指向同一个迎新夜晚。",
        "tags": ["悬疑", "校园", "人物关系"],
    },
    {
        "title": "下一章方向",
        "content": "知足跟随林知意离开宿舍，途中遇见周临。三人在雨中第一次正面冲突，并发现短信发送地点来自废弃社团活动室。",
        "tags": ["续写", "冲突", "场景"],
    },
]


def _word_count(text: str) -> int:
    return len(text.replace(" ", "").replace("\n", ""))


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
            selectinload(Book.character_relations),
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
        character_relations=[CharacterRelationResponse.model_validate(r) for r in (book.character_relations or [])],
        inspirations=[InspirationResponse.model_validate(i) for i in (book.inspirations or [])],
    )


@router.post("/demo/seed", response_model=BookResponse)
async def seed_demo_book(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    existing_result = await db.execute(
        select(Book).where(Book.owner_id == current_user.id, Book.title == DEMO_BOOK_TITLE)
    )
    existing_book = existing_result.scalar_one_or_none()
    if existing_book:
        return await get_book(existing_book.id, current_user, db)

    book = Book(
        title=DEMO_BOOK_TITLE,
        description=DEMO_DESCRIPTION,
        status="SERIAL",
        owner_id=current_user.id,
    )
    db.add(book)
    await db.flush()

    total_words = 0
    for order, chapter_data in enumerate(DEMO_CHAPTERS, start=1):
        chapter_words = _word_count(chapter_data["content"])
        total_words += chapter_words
        db.add(
            Chapter(
                title=chapter_data["title"],
                content=chapter_data["content"],
                word_count=chapter_words,
                status="DRAFT",
                order=order,
                book_id=book.id,
            )
        )

    db.add(
        Outline(
            title="第一卷：雨巷边缘",
            content=DEMO_OUTLINE,
            order=1,
            book_id=book.id,
        )
    )
    for inspiration_data in DEMO_INSPIRATIONS:
        db.add(
            Inspiration(
                title=inspiration_data["title"],
                content=inspiration_data["content"],
                tags=json.dumps(inspiration_data["tags"], ensure_ascii=False),
                book_id=book.id,
            )
        )

    characters_by_name = {}
    for character_data in DEMO_CHARACTERS:
        character = Character(
            name=character_data["name"],
            role=character_data["role"],
            bio=character_data["bio"],
            book_id=book.id,
        )
        db.add(character)
        characters_by_name[character_data["name"]] = character
    await db.flush()

    for source, target, relation_type, description, strength in DEMO_RELATIONS:
        source_character = characters_by_name.get(source)
        target_character = characters_by_name.get(target)
        if not source_character or not target_character:
            continue
        db.add(
            CharacterRelation(
                source_character_id=source_character.id,
                target_character_id=target_character.id,
                relation_type=relation_type,
                description=description,
                strength=strength,
                book_id=book.id,
            )
        )

    book.word_count = total_words
    await db.commit()
    return await get_book(book.id, current_user, db)


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
    return BookListResponse.model_validate(book)
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
        # 自动索引：将章节内容向量化，用于 RAG 语义搜索
        await index_chapter(db, chapter.id, data.content, chapter.book_id)

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


@router.get("/books/{book_id}/character-relations", response_model=list[CharacterRelationResponse])
async def list_character_relations(
    book_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(CharacterRelation).join(Book).where(
            CharacterRelation.book_id == book_id,
            Book.owner_id == current_user.id,
        ).order_by(CharacterRelation.created_at.desc())
    )
    return [CharacterRelationResponse.model_validate(r) for r in result.scalars().all()]


@router.post("/books/{book_id}/character-relations", response_model=CharacterRelationResponse, status_code=status.HTTP_201_CREATED)
async def create_character_relation(
    book_id: str,
    data: CharacterRelationCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if data.source_character_id == data.target_character_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不能创建角色自身关系")

    book_result = await db.execute(select(Book).where(Book.id == book_id, Book.owner_id == current_user.id))
    book = book_result.scalar_one_or_none()
    if not book:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="作品不存在")

    character_result = await db.execute(
        select(Character).where(
            Character.book_id == book_id,
            Character.id.in_([data.source_character_id, data.target_character_id]),
        )
    )
    if len(character_result.scalars().all()) != 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="关系中的角色不存在")

    relation = CharacterRelation(
        source_character_id=data.source_character_id,
        target_character_id=data.target_character_id,
        relation_type=data.relation_type,
        description=data.description or "",
        strength=max(1, min(data.strength, 5)),
        book_id=book_id,
    )
    db.add(relation)
    await db.commit()
    await db.refresh(relation)
    return CharacterRelationResponse.model_validate(relation)


@router.delete("/books/{book_id}/character-relations/{relation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_character_relation(
    book_id: str,
    relation_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(CharacterRelation).join(Book).where(
            CharacterRelation.id == relation_id,
            CharacterRelation.book_id == book_id,
            Book.owner_id == current_user.id,
        )
    )
    relation = result.scalar_one_or_none()
    if not relation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="关系不存在")

    await db.delete(relation)
    await db.commit()


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
