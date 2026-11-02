// A backticked name is a traversal ROOT like any other (layer 13 idiom fix).
// The scanner strips backticks from the parsed root, so every site that
// recomposes source text from a head must re-spell it (`spellPathHead`) —
// recomposing bare was how `` `The Check`-[:Answer]-> `` failed to re-parse
// in statement and await form while the pure-expression form worked.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const schema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text' },
      edges: { Checks: { target: 'check', readable: true } },
    },
    check: {
      properties: { Label: 'text' },
      edges: { Answer: { target: 'answer', readable: true, listenable: true } },
    },
    answer: { properties: { Text: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};
const catalog = mockCatalog({ adapters: { email: { constructionArgs: [], schema } } });

// Version 4 is the last that spells the parked read `await FIRST(…)`: the
// installed language's parser reads the dialect '5' as 0.13 does, where
// `await first(…)` is respelled to the bare walk.
function codes(body: string, languageVersion: '4' | '5' = '5'): string[] {
  const construct = languageVersion === '4' ? 'email()' : 'connect email';
  const src = `import { email } from adapters\ninbox = ${construct}\n\nfunction m(e: <inbox-[:message]->>) {\n${body}\n}`;
  return checkProgram(parseProgram(src, { languageVersion }), catalog, { languageVersion })
    .filter((d: Diagnostic) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

const BOUND = '  `The Check` = only(e-[k:Checks]->)\n';

describe('a backticked binding walks like a bare one', () => {
  it('as a block-statement head', () => {
    expect(codes(BOUND + '  if (`The Check` != null) {\n    `The Check`-[a:Answer]-> {\n      t = a.`Text`\n    }\n  }')).toEqual([]);
  });

  it('under await FIRST', () => {
    expect(
      codes('  `The Check` = ONLY(e-[k:Checks]->)\n  w = await FIRST(`The Check`-[a:Answer]->)\n  t = w.`Text`', '4'),
    ).toEqual([]);
  });

  it('as an expression traversal', () => {
    expect(codes(BOUND + '  if (`The Check` != null) {\n    t = `The Check`-[:Answer]->.`Text`\n  }')).toEqual([]);
  });

  it('a bad edge off a backticked root is still the ordinary edge error', () => {
    expect(codes(BOUND + '  `The Check`-[v:Nope]-> {\n  }')).toContain(
      'MOV_TRAVERSE_UNKNOWN_EDGE',
    );
  });
});

// A block head's hop alias is a name like any other: backtick-quoted, escapes
// and all, it binds exactly as a bare alias does.
describe('a backticked hop alias in a block head binds like a bare one', () => {
  it.each([
    ['a spaced alias', '`the check`'],
    ['an escaped backtick', '`the\\`check`'],
    ['an escaped backslash', '`the\\\\check`'],
  ])('%s', (_label, alias) => {
    expect(codes(`  e-[${alias}:Checks]-> {\n    t = ${alias}.\`Label\`\n  }`)).toEqual([]);
  });
});
