// What `readBook` serves the in-app agents (whole chapters) and what it serves
// the automations connector, which asks for the front page instead of chapters.

import { readBook } from '../index';
import { renderFrontPage } from '../../movement_handbook';

type Read = {
  chapter?: string;
  content?: string;
  note?: string;
  whenToReadWhat?: string;
  chapters?: Array<{ id: string; content?: string; note?: string; error?: string }>;
};

const read = (args: Parameters<typeof readBook>[0]) => readBook(args) as Read;

describe('whole chapters (the in-app agents)', () => {
  it('is the default, and serves the index and whole chapters', () => {
    expect(read({ bookId: 'automations' }).whenToReadWhat).toMatch(/When you need to/);
    expect(read({ bookId: 'automations', chapter: 'writes' }).content).toContain('unique by');
  });

  it('serves the front page too, so a diagnostic pointing at it resolves', () => {
    expect(read({ bookId: 'automations', chapter: 'front' }).content).toBe(renderFrontPage());
    expect(read({ bookId: 'automations', chapter: 'front#maybe-absent' }).content).toMatch(/absent/);
  });
});

describe('the front page instead of chapters (the automations connector)', () => {
  const lookup = { frontPageInsteadOfChapters: true } as const;

  it('serves the front page where the book index was', () => {
    const r = read({ bookId: 'automations', ...lookup });
    expect(r.chapter).toBe('front');
    expect(r.content).toBe(renderFrontPage());
    expect(r.whenToReadWhat).toBeUndefined();
  });

  it('answers a whole hand-written chapter with a pointer to the search', () => {
    const r = read({ bookId: 'automations', chapter: 'writes', ...lookup });
    expect(r.content).toBeUndefined();
    expect(r.note).toMatch(/searchLanguage/);
  });

  it('still serves a section, a system chapter, and the front page sections', () => {
    expect(read({ bookId: 'automations', chapter: 'writes#identity', ...lookup }).content).toContain('unique by');
    expect(read({ bookId: 'automations', chapter: 'system:slack', ...lookup }).content?.length).toBeGreaterThan(100);
    expect(read({ bookId: 'automations', chapter: 'front#identity', ...lookup }).content).toContain('unique by');
  });

  it('mixes pointers and bodies in one read of several', () => {
    const r = read({ bookId: 'automations', chapters: ['patterns', 'writes#identity'], ...lookup });
    expect(r.chapters?.[0]?.note).toMatch(/searchLanguage/);
    expect(r.chapters?.[1]?.content).toContain('unique by');
  });

  it('lists the automations book as its front page on the shelf, and leaves other books alone', () => {
    const shelf = (readBook(lookup) as { shelf: Array<{ bookId: string; chapters: Array<{ id: string }> }> }).shelf;
    expect(shelf.find((b) => b.bookId === 'automations')?.chapters.map((c) => c.id)).toEqual(['front']);
    expect(shelf.find((b) => b.bookId === 'knowledge-model')?.chapters.length).toBeGreaterThan(1);
  });

  it('an unknown chapter is still an error, not a pointer', () => {
    const r = readBook({ bookId: 'automations', chapter: 'nope', ...lookup }) as { chapters?: Array<{ error?: string }> };
    expect(r.chapters?.[0]?.error).toMatch(/No chapter/);
  });
});
