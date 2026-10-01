import { describe, expect, it } from 'vitest';

import {
  blocks,
  bookFavorites,
  bookLikes,
  comments,
  follows,
  notifications,
  reports,
  readingProgress,
  users,
  books,
} from '../src/db/schema';

describe('public community schema', () => {
  it('exposes publication metadata on users and books', () => {
    expect(users.username).toBeDefined();
    expect(users.bio).toBeDefined();
    expect(books.visibility).toBeDefined();
    expect(books.genre).toBeDefined();
    expect(books.tags).toBeDefined();
    expect(books.publishedAt).toBeDefined();
  });

  it('exports social tables used by community interactions', () => {
    expect(follows).toBeDefined();
    expect(bookLikes).toBeDefined();
    expect(bookFavorites).toBeDefined();
    expect(comments).toBeDefined();
    expect(readingProgress).toBeDefined();
    expect(notifications).toBeDefined();
    expect(reports).toBeDefined();
    expect(blocks).toBeDefined();
  });
});
