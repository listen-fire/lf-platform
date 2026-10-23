// The story a release pin's analysis draws is the story legacy-lang drew under
// '5'. The corpus is every current-pin program this platform holds to the
// wasm: the handbook's runnable claims and this platform's sections (the
// current-pin conformance corpus), the story view's fixture, legacy-lang's
// own story fixtures, and the dev loop's probes. A difference no ruling
// covers fails; each ruling must still be needed.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

import fs from 'node:fs';
import path from 'node:path';

import { CORE_CHAPTERS } from '@listen-fire/handbook';
import { HANDBOOK_CATALOG, checkExemption, claimsOf } from '@listen-fire/handbook/testing';
import { LANGUAGE_VERSION, type CatalogSnapshot } from 'movement-lang';

import { getMovementHandbook } from '../../../../lib/knowledge/movement_handbook';
import { storyFromAnalysis } from '../story_from_analysis';
import { compareStories, legacyStoryUnder5, rulingHits, type StoryComparison } from '../story_parity';
import { LEGACY_STORY_SNAPSHOT, LEGACY_STORY_SOURCES } from './__fixtures__/story/legacy_story';
import { STORY_VIEW_SNAPSHOT, STORY_VIEW_SOURCE } from './__fixtures__/story/story_view';

interface Program {
  /** How the pending set names it: `claim <n>`, `probe <file>`, … */
  id: string;
  name: string;
  source: string;
  snapshot: CatalogSnapshot;
}

// The current-pin conformance corpus (services/movement_engine/__test__/current_pin_conformance).
const book = getMovementHandbook();
const added = Object.values(book.chapters).filter((c) => !(c.id in CORE_CHAPTERS));
const runs = [...claimsOf(Object.values(CORE_CHAPTERS)), ...claimsOf(added)]
  .filter((c) => checkExemption(c) === undefined)
  .flatMap((c) => (c.status === 'runs' ? [c] : []));
const claimPrograms: Program[] = runs.map((claim, i) => ({
  id: `claim ${i}`,
  name: `claim ${i} ${claim.chapter}: ${claim.construct}`,
  source: claim.probe,
  snapshot: claim.files
    ? {
        ...HANDBOOK_CATALOG,
        files: Object.fromEntries(Object.entries(claim.files).map(([file, source]) => [file, { source }])),
      }
    : HANDBOOK_CATALOG,
}));
const sectionPrograms: Program[] = added.flatMap((c) =>
  [...c.content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? '')
    .filter((block) => /^listen\b/m.test(block))
    .map((source, i) => ({ id: `section ${c.id} ${i}`, name: `section ${c.id} ${i}`, source, snapshot: HANDBOOK_CATALOG })),
);
const namedCases: Program[] = [
  'function echo(run: <manual-[:Invocation]->>) {\n  return 1\n}\nlisten to manual fire echo\n',
  'function echo(run: <manual-[:Invocation]->>) {\n  return 1\n}\nlisten as "Echo it" to manual fire echo\n',
  'import { manual } from adapters\nruns = connect manual\nfunction echo(run: <runs-[:Invocation]->>) {\n  return 1\n}\nlisten to runs fire echo\n',
].map((source, i) => ({ id: `named case ${i}`, name: `named case ${i}`, source, snapshot: HANDBOOK_CATALOG }));

const FIXTURES = path.resolve(__dirname, '../../../../scripts/dev/_fixtures');
const probes: Program[] = fs
  .readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.mvt'))
  .sort()
  .map((file) => ({ id: `probe ${file}`, name: `probe ${file}`, source: fs.readFileSync(path.join(FIXTURES, file), 'utf8'), snapshot: HANDBOOK_CATALOG }));

/** A movement calling one imported from a library file (the dev stack's `tick` and `lib/greet`). */
const importedCall: Program = {
  id: 'imported movement call',
  name: 'imported movement call',
  source: [
    'import { ledger_sys } from adapters',
    'import { ledger_creds } from credentials',
    'import { greet } from "lib/greet"',
    'books = connect ledger_sys using ledger_creds',
    'function tock(t: <cron-[:Tick]->>) {',
    '  write books-[:Orgs]-> { Title: greet("${t.`Fired at`}") }',
    '}',
    'listen to cron { schedule: "* * * * *" } fire tock',
    '',
  ].join('\n'),
  snapshot: {
    ...STORY_VIEW_SNAPSHOT,
    files: { 'lib/greet': { source: 'export function greet(name: <text>) {\n  return "Hi, ${name}!"\n}\n' } },
  },
};

const corpus: Program[] = [
  ...claimPrograms,
  ...sectionPrograms,
  ...namedCases,
  { id: 'story view fixture', name: 'story view fixture', source: STORY_VIEW_SOURCE, snapshot: STORY_VIEW_SNAPSHOT },
  importedCall,
  ...Object.entries(LEGACY_STORY_SOURCES).map(([name, source]) => ({
    id: `legacy story ${name}`,
    name: `legacy story ${name}`,
    source,
    snapshot: LEGACY_STORY_SNAPSHOT,
  })),
  ...probes,
];

function compared(program: Program): StoryComparison {
  return compareStories(
    legacyStoryUnder5(program.source, program.snapshot),
    storyFromAnalysis({ source: program.source, snapshot: program.snapshot, pin: LANGUAGE_VERSION }).result,
  );
}

describe('the story parity', () => {
  it('holds the whole corpus', () => {
    expect(probes).toHaveLength(13);
    expect(Object.keys(LEGACY_STORY_SOURCES).length).toBeGreaterThan(0);
    expect(claimPrograms.length).toBeGreaterThan(0);
    expect(sectionPrograms.length).toBeGreaterThan(0);
  });

  it("every current-pin program in the corpus draws the same story from the analysis as from legacy-lang under '5'", () => {
    const comparisons = corpus.map((program) => ({ program, comparison: compared(program) }));
    const hits = rulingHits(comparisons.map((c) => c.comparison));
    const ruled = comparisons.flatMap(({ program, comparison }) =>
      comparison.ruled.map((r) => `${r.ruling} ${program.name} ${r.path}: ${JSON.stringify(r.legacy)} -> ${JSON.stringify(r.wasm)}`),
    );
    // eslint-disable-next-line no-console
    console.log(
      [`story parity: ${corpus.length} programs; hits ${JSON.stringify(hits)}`, ...ruled].join('\n'),
    );
    const differences = comparisons
      .flatMap(({ program, comparison }) =>
        comparison.differences.map((d) => `${program.name} ${d.path}: ${JSON.stringify(d.legacy)} != ${JSON.stringify(d.wasm)}`),
      );
    expect(differences).toEqual([]);
    for (const count of Object.values(hits)) expect(count).toBeGreaterThan(0);
  });
});
