// A function handed to MAP (and every other closure) is a body the run
// executes, so the chains inside it are the movement's demand exactly as if
// they were written outside it. The scan once skipped such bodies, so a type
// reached only by walking from a handle bound inside one was never described
// and the checker checked that write against nothing.

import { LANGUAGE_VERSION } from 'movement-lang/language_version';

import { scanInstanceChains } from '../selectors';
import { pastLegacy } from '../../version_conditionals';

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme } from credentials',
  'inbox = email()',
  'crm   = attio(credentials: acme)',
  'node Company: "each company named in this message" {',
  '  name: <text> "the company\'s name"',
  '}',
].join('\n');

/** The handbook's extraction example: write a company, then walk from the
 *  written record to its list entry. */
const WRITES = [
  'record = write crm-[:Companies]-> { unique by (FUZZY `Name`), Name: c.name }',
  'write record-[:Lists]-> { listName: "VC Deal Flow" }',
  'm-[a:Attachments]-> {',
  '  write record-[:Files]-> { File: a.`File` }',
  '}',
];

const movement = (body: string[]) =>
  [
    PRELUDE,
    'function `Intake`(m: <inbox-[:Email]->>) {',
    '  companies = extract([m.`Body`], Company, { tier: \'careful\' })',
    ...body.map((line) => `  ${line}`),
    '}',
  ].join('\n');

const insideMap = movement(['MAP(companies, (c) => {', ...WRITES.map((l) => `  ${l}`), '})']);
const outsideMap = movement(['c = ONLY(companies)', ...WRITES]);

/** Each chain as `adapter: edge → edge`, sorted, for comparing two scans. */
const paths = (source: string, languageVersion?: number | string) =>
  scanInstanceChains(source, languageVersion !== undefined ? { languageVersion: String(languageVersion) } : undefined)
    .map(
      (chain) =>
        `${chain.adapter}${chain.startPosition !== undefined ? `@${chain.startPosition}` : ''}: ` +
        chain.steps.map((step) => (step.type === 'edge' ? step.edgeTypeId : '?')).join(' → '),
    )
    .sort();

describe('the demand scan reads the body of a function handed to a built-in', () => {
  it('walks the same paths inside MAP as outside it', () => {
    const outside = paths(outsideMap);
    expect(outside).toEqual(
      expect.arrayContaining(['attio: Companies', 'attio: Companies → Lists', 'attio: Companies → Files']),
    );
    expect(paths(insideMap)).toEqual(outside);
  });

  it('a hop off the function\'s untyped parameter grounds nothing', () => {
    const source = movement(['MAP(companies, (c) => {', '  c-[p:person]-> { }', '})']);
    expect(paths(source)).toEqual([]);
  });

  it('a parameter typed with a position roots chains at that type', () => {
    const source = movement([
      'MAP(companies, (co: <crm-[:Companies]->>) => {',
      '  write co-[:Lists]-> { listName: "VC Deal Flow" }',
      '})',
    ]);
    expect(paths(source)).toEqual(['attio@Companies: Lists']);
  });

  it('a parameter shadows a handle of the same name bound outside the function', () => {
    const source = movement([
      'record = write crm-[:Companies]-> { Name: "Acme" }',
      'MAP(companies, (record) => {',
      '  record-[:Lists]-> { }',
      '})',
    ]);
    expect(paths(source)).toEqual(['attio: Companies']);
  });

  it('a release pin walks the function body, reading the pin without mapping it to an integer', () => {
    expect(paths(insideMap, LANGUAGE_VERSION)).toEqual(paths(outsideMap, LANGUAGE_VERSION));
    expect(paths(insideMap, LANGUAGE_VERSION)).not.toEqual([]);
  });

  it('a movement pinned to version 1 or 2 keeps the scan it was saved under', () => {
    for (const languageVersion of [1, 2]) {
      expect(paths(insideMap, languageVersion)).toEqual([]);
    }
  });
});

describe('pastLegacy', () => {
  it('a release pin is past every legacy behaviour; a legacy id compares as its integer', () => {
    expect(pastLegacy('0.13.0', 3)).toBe(true);
    expect(pastLegacy(LANGUAGE_VERSION, 3)).toBe(true);
    expect(pastLegacy('2', 3)).toBe(false);
    expect(pastLegacy('3', 3)).toBe(true);
  });
});
