// showExample serves the language's micro examples, as `listen-fire example`
// does: the front page sends an author to it by that name.

import { renderFrontPage, showExample } from '..';

describe('showExample', () => {
  it('answers words with checked lines under a comment saying what they do', () => {
    const answer = showExample({ query: 'create or update a record' });
    expect(answer).toMatch(/^# /);
    expect(answer).toContain('unique by');
  });

  it('lists every example with no words', () => {
    const index = showExample({});
    expect(index).toContain('Every example; ask for one in your own words:');
    expect(index.split('\n').length).toBeGreaterThan(20);
  });

  it('is the tool the front page names', () => {
    expect(renderFrontPage()).toContain('showExample');
  });
});
