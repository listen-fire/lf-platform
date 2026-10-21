// The anchors diagnostics cite (movement-lang's HANDBOOK_POINTERS) are this
// handbook's: each must resolve to a section with something to read, so a
// refusal that says where the right form is shown never points at nothing.
// A host that serves the handbook holds the same anchors through its own
// reader.

import { HANDBOOK_POINTERS, HANDBOOK_POINTER_BY_CODE } from 'movement-lang';
import { splitChapterRoute } from 'engine-contracts/handbook_section';

import { frontSection, getCoreChapter } from '../index';

/** `front#<anchor>` is the front page's; any other route a hand-written chapter's. */
function readAnchor(anchor: string): { ok: true; content: string } | { ok: false; error: string } {
  const route = splitChapterRoute(anchor);
  if (route.chapter === 'front' && route.section !== undefined) return frontSection(route.section);
  return getCoreChapter(route.chapter, route.section);
}

describe('diagnostics point at a section that exists', () => {
  const anchors = [...new Set([...Object.values(HANDBOOK_POINTERS), ...Object.values(HANDBOOK_POINTER_BY_CODE)])];

  it('there are anchors to hold', () => {
    expect(anchors.length).toBeGreaterThan(0);
  });

  it.each(anchors)('%s resolves through the handbook', (anchor) => {
    const read = readAnchor(anchor);
    if (!read.ok) throw new Error(`${anchor}: ${read.error}`);
    expect(read.content.length).toBeGreaterThan(40);
  });
});
