// Completion, hover, definition and the story are presentation surfaces, and
// this copy presents the legacy ids '1' to '4' only. A release pin is the
// installed language's (the wasm); '5' is the checker's upgrade target, never
// a pin anyone presents. Either reaching here is a routing bug, refused at the
// entry before any work.

import { EMPTY_CATALOG_SNAPSHOT } from 'movement-lang/service/snapshot';
import { LANGUAGE_VERSION } from 'movement-lang/language_version';

import { getDefinition, getHoverInfo, getMovementCompletions } from '../service/service';
import { analyze } from '../service/analysis';
import { storyOf } from '../story/story';
import { mockCatalog } from '../checker/catalog';
import { LegacyPinRefused, assertLegacyPresentationPin } from '../version_conditionals';

const SOURCE = 'import { mail } from adapters\n';

const surfaces: Array<[string, (languageVersion?: string) => unknown]> = [
  ['completion', (v) => getMovementCompletions(SOURCE, 0, EMPTY_CATALOG_SNAPSHOT, v === undefined ? undefined : { languageVersion: v })],
  ['hover', (v) => getHoverInfo(SOURCE, 0, EMPTY_CATALOG_SNAPSHOT, v === undefined ? undefined : { languageVersion: v })],
  ['definition', (v) => getDefinition(SOURCE, 0, EMPTY_CATALOG_SNAPSHOT, v === undefined ? undefined : { languageVersion: v })],
  [
    'story',
    (v) => storyOf({ source: SOURCE, catalog: mockCatalog({ adapters: {}, credentials: {} }), ...(v === undefined ? {} : { languageVersion: v }) }),
  ],
];

describe('assertLegacyPresentationPin', () => {
  it("passes the legacy ids and refuses '5' and a release pin", () => {
    for (const pin of ['1', '2', '3', '4']) expect(() => assertLegacyPresentationPin(pin)).not.toThrow();
    for (const pin of ['5', '0.12.0', LANGUAGE_VERSION]) {
      expect(() => assertLegacyPresentationPin(pin)).toThrow(LegacyPinRefused);
    }
    expect(() => assertLegacyPresentationPin(5)).toThrow(LegacyPinRefused);
  });

  it("leaves an unsupported integer to the checker's version diagnostic", () => {
    expect(() => assertLegacyPresentationPin('99')).not.toThrow();
    const result = storyOf({ source: SOURCE, catalog: mockCatalog({ adapters: {}, credentials: {} }), languageVersion: '99' });
    expect(result.ok && JSON.stringify(result.story)).toContain('MOV_LANGUAGE_VERSION_UNSUPPORTED');
  });
});

describe.each(surfaces)('%s', (_name, ask) => {
  it("refuses '5' and a semver, and an absent pin (which reads as '5')", () => {
    expect(() => ask('5')).toThrow(LegacyPinRefused);
    expect(() => ask(LANGUAGE_VERSION)).toThrow(LegacyPinRefused);
    expect(() => ask()).toThrow(LegacyPinRefused);
  });

  it('answers a legacy id', () => {
    expect(() => ask('4')).not.toThrow();
  });
});

describe('analyze', () => {
  it('keeps one analysis per pin, so a second pin is not answered from the first', () => {
    const snapshot = { ...EMPTY_CATALOG_SNAPSHOT };
    const source = 'x = 1\n';
    const four = analyze(source, snapshot, { languageVersion: '4' });
    expect(analyze(source, snapshot, { languageVersion: '4' })).toBe(four);
    expect(analyze(source, snapshot, { languageVersion: '3' })).not.toBe(four);
  });
});
