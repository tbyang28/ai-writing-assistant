import type { Book, Chapter, Character, CharacterRelation, Inspiration, Outline } from '../db/schema';

/**
 * 响应形状映射 —— 对应 Python 侧 pydantic 响应模型（schemas/book.py）。
 * 所有字段名保持 snake_case（前端契约）。
 * Date 直接返回，JSON.stringify 序列化为 ISO（比 Python 的 naive datetime 多一个 Z，
 * new Date() 两种都能解析，且带 Z 的时间在前端不再差 8 小时）。
 */

/** Python 的 _book_list_payload / BookListResponse */
export function toBookListPayload(book: Book) {
  return {
    id: book.id,
    title: book.title,
    cover: book.cover,
    description: book.description,
    status: book.status,
    word_count: book.wordCount,
    owner_id: book.ownerId,
    created_at: book.createdAt,
    updated_at: book.updatedAt,
  };
}

/** ChapterResponse */
export function toChapterResponse(chapter: Chapter) {
  return {
    id: chapter.id,
    title: chapter.title,
    content: chapter.content,
    word_count: chapter.wordCount,
    status: chapter.status,
    order: chapter.order,
    book_id: chapter.bookId,
    created_at: chapter.createdAt,
    updated_at: chapter.updatedAt,
  };
}

/** OutlineResponse */
export function toOutlineResponse(outline: Outline) {
  return {
    id: outline.id,
    title: outline.title,
    content: outline.content,
    order: outline.order,
    book_id: outline.bookId,
  };
}

/** CharacterResponse */
export function toCharacterResponse(character: Character) {
  return {
    id: character.id,
    name: character.name,
    role: character.role,
    avatar: character.avatar,
    bio: character.bio,
    book_id: character.bookId,
  };
}

/** CharacterRelationResponse */
export function toCharacterRelationResponse(relation: CharacterRelation) {
  return {
    id: relation.id,
    source_character_id: relation.sourceCharacterId,
    target_character_id: relation.targetCharacterId,
    relation_type: relation.relationType,
    description: relation.description,
    strength: relation.strength,
    book_id: relation.bookId,
    created_at: relation.createdAt,
    updated_at: relation.updatedAt,
  };
}

/** InspirationResponse（tags 是 JSON 字符串，契约如此） */
export function toInspirationResponse(inspiration: Inspiration) {
  return {
    id: inspiration.id,
    title: inspiration.title,
    content: inspiration.content,
    tags: inspiration.tags,
    book_id: inspiration.bookId,
    created_at: inspiration.createdAt,
  };
}

/** GET /books/:id 的完整 BookResponse（含 5 个集合） */
export function toBookResponse(
  book: Book,
  collections: {
    chapters: Chapter[];
    outlines: Outline[];
    characters: Character[];
    characterRelations: CharacterRelation[];
    inspirations: Inspiration[];
  },
) {
  return {
    ...toBookListPayload(book),
    chapters: collections.chapters.map(toChapterResponse),
    outlines: collections.outlines.map(toOutlineResponse),
    characters: collections.characters.map(toCharacterResponse),
    character_relations: collections.characterRelations.map(toCharacterRelationResponse),
    inspirations: collections.inspirations.map(toInspirationResponse),
  };
}
