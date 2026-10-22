// The current pin is judged by the wasm checker alone. The corpus is what the
// installed handbook publishes (its claims, which the language holds to the
// same checker), this platform's own sections, and the named cases the
// manual listen turns on. Every program goes through the platform's real
// validation, `diagnoseMovementSource`, and must say exactly what the wasm
// says about the same text against the same snapshot; the legacy checker and
// the interpretability scan are asked only for a legacy id.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

const counters = { checkProgram: 0, checkProgramWithLink: 0, scan: 0 };

jest.mock('legacy-lang', () => {
  const actual = jest.requireActual('legacy-lang');
  return {
    ...actual,
    checkProgram: (...args: unknown[]) => {
      counters.checkProgram += 1;
      return actual.checkProgram(...args);
    },
    checkProgramWithLink: (...args: unknown[]) => {
      counters.checkProgramWithLink += 1;
      return actual.checkProgramWithLink(...args);
    },
  };
});

jest.mock('@listen-fire/legacy-engine/services/movement_engine/interpretable', () => {
  const actual = jest.requireActual(
    '@listen-fire/legacy-engine/services/movement_engine/interpretable',
  );
  return {
    ...actual,
    listUnsupportedConstructs: (...args: unknown[]) => {
      counters.scan += 1;
      return actual.listUnsupportedConstructs(...args);
    },
  };
});

import { CORE_CHAPTERS } from '@listen-fire/handbook';
import { HANDBOOK_CATALOG, checkExemption, claimsOf } from '@listen-fire/handbook/testing';
import { collectFileListeners } from '@listen-fire/legacy-engine/services/translation_graph/file_listeners';
import {
  LANGUAGE_VERSION,
  checkSourceInRust,
  fromCatalogSnapshot,
  parseProgram,
  type LanguageVersion,
} from 'movement-lang';

import { getMovementHandbook } from '../../../lib/knowledge/movement_handbook';
import {
  diagnoseMovementSource,
  formatMovementDiagnostics,
} from '../../translation_graph/movement/authoring';
import { manualListenerMovements } from '../../translation_graph/movement/files';

const catalog = fromCatalogSnapshot(HANDBOOK_CATALOG);

function platform(source: string, languageVersion: LanguageVersion = LANGUAGE_VERSION) {
  return diagnoseMovementSource(source, { catalog, snapshot: HANDBOOK_CATALOG, languageVersion });
}

function wasm(source: string) {
  return formatMovementDiagnostics(
    source,
    checkSourceInRust(source, HANDBOOK_CATALOG, { languageVersion: LANGUAGE_VERSION }),
  );
}

const errorCodes = (diagnostics: Array<{ code: string; severity: string }>) =>
  diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

function expectOkAsTheWasmSays(source: string) {
  const verdict = platform(source);
  expect(verdict.diagnostics).toEqual(wasm(source));
  expect(errorCodes(verdict.diagnostics)).toEqual([]);
  expect(verdict.ok).toBe(true);
}

const BARE_MANUAL =
  'function echo(run: <manual-[:Invocation]->>) {\n  return 1\n}\nlisten to manual fire echo\n';
const LISTEN_AS =
  'function echo(run: <manual-[:Invocation]->>) {\n  return 1\n}\nlisten as "Echo it" to manual fire echo\n';
const CONNECT_MANUAL =
  'import { manual } from adapters\nruns = connect manual\nfunction echo(run: <runs-[:Invocation]->>) {\n  return 1\n}\nlisten to runs fire echo\n';

const book = getMovementHandbook();
const chapters = Object.values(book.chapters);
const added = chapters.filter((c) => !(c.id in CORE_CHAPTERS));
const checkable = (claims: ReturnType<typeof claimsOf>) =>
  claims.filter((c) => checkExemption(c) === undefined);
const claims = checkable([...claimsOf(Object.values(CORE_CHAPTERS)), ...claimsOf(added)]);
const runs = claims.filter((c) => c.status === 'runs');
const pending = claims.filter((c) => c.status === 'pending');

// A whole program is a fenced block that listens: the fragments a section
// shows beside it are not programs.
function wholePrograms(content: string): string[] {
  return [...content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((block) => /^listen\b/m.test(block));
}
const sectionExamples = added.flatMap((c) =>
  wholePrograms(c.content).map((source, i) => ({ chapter: c.id, index: i, source })),
);

beforeEach(() => {
  counters.checkProgram = 0;
  counters.checkProgramWithLink = 0;
  counters.scan = 0;
});

describe("claims of the handbook, through the platform's validation", () => {
  it('has claims to hold', () => {
    expect(runs.length).toBeGreaterThan(0);
    expect(pending.length).toBeGreaterThan(0);
  });

  it.each(runs.map((c) => [c.chapter, c.construct, c] as const))(
    '%s runs "%s"',
    (_chapter, _construct, claim) => {
      // A claim with files resolves its imports from them; the platform has no
      // file store here, so the program is held to the wasm's same input.
      const files = claim.status === 'runs' ? claim.files : undefined;
      const snapshot = files
        ? {
            ...HANDBOOK_CATALOG,
            files: Object.fromEntries(
              Object.entries(files).map(([path, source]) => [path, { source }]),
            ),
          }
        : HANDBOOK_CATALOG;
      const verdict = diagnoseMovementSource(claim.probe, {
        catalog: fromCatalogSnapshot(snapshot),
        snapshot,
        languageVersion: LANGUAGE_VERSION,
      });
      expect(verdict.diagnostics).toEqual(
        formatMovementDiagnostics(
          claim.probe,
          checkSourceInRust(claim.probe, snapshot, { languageVersion: LANGUAGE_VERSION }),
        ),
      );
      expect(errorCodes(verdict.diagnostics)).toEqual([]);
      expect(verdict.ok).toBe(true);
    },
  );

  it.each(pending.map((c) => [c.chapter, c.construct, c] as const))(
    '%s still refuses "%s"',
    (_chapter, _construct, claim) => {
      const verdict = platform(claim.probe);
      expect(verdict.ok).toBe(false);
      expect(errorCodes(verdict.diagnostics)).toEqual(errorCodes(wasm(claim.probe)));
    },
  );
});

// Most system sections end on a `listen` whose movement and instance are
// shown in an earlier fragment of the section, so only equality with the wasm
// is asked of them; these three stand alone and must also be clean.
const SELF_CONTAINED_SECTIONS = ['system:manual', 'system:cron', 'system:system'];

describe("whole-program examples of this platform's sections", () => {
  it("has examples to hold, system:manual's among them", () => {
    expect(sectionExamples.length).toBeGreaterThan(0);
    expect(sectionExamples.some((e) => e.chapter === 'system:manual')).toBe(true);
  });

  it.each(sectionExamples.map((e) => [e.chapter, e.index, e.source] as const))(
    '%s example %i is what the wasm says (clean when self-contained)',
    (_chapter, _index, source) => {
      const verdict = platform(source);
      expect(verdict.diagnostics).toEqual(wasm(source));
      if (SELF_CONTAINED_SECTIONS.includes(_chapter)) {
        expect(errorCodes(verdict.diagnostics)).toEqual([]);
        expect(verdict.ok).toBe(true);
      }
    },
  );
});

describe('named cases', () => {
  it('a bare `listen to manual fire echo` validates and derives one manual listener', () => {
    expectOkAsTheWasmSays(BARE_MANUAL);
    const program = parseProgram(BARE_MANUAL, { languageVersion: LANGUAGE_VERSION });
    expect(
      collectFileListeners(program, { languageVersion: LANGUAGE_VERSION }).map((l) => [
        l.adapter,
        l.movementName,
      ]),
    ).toEqual([['manual', 'echo']]);
    expect(manualListenerMovements(program, { languageVersion: LANGUAGE_VERSION })).toEqual([
      'echo',
    ]);
  });

  it('the `listen as` form validates and derives the same listener', () => {
    expectOkAsTheWasmSays(LISTEN_AS);
    const program = parseProgram(LISTEN_AS, { languageVersion: LANGUAGE_VERSION });
    expect(
      collectFileListeners(program, { languageVersion: LANGUAGE_VERSION }).map((l) => [
        l.adapter,
        l.movementName,
      ]),
    ).toEqual([['manual', 'echo']]);
    expect(manualListenerMovements(program, { languageVersion: LANGUAGE_VERSION })).toEqual([
      'echo',
    ]);
  });

  it("the `connect manual` form validates and keeps the file's own construction", () => {
    expectOkAsTheWasmSays(CONNECT_MANUAL);
    const program = parseProgram(CONNECT_MANUAL, { languageVersion: LANGUAGE_VERSION });
    expect(
      collectFileListeners(program, { languageVersion: LANGUAGE_VERSION }).map((l) => [
        l.instanceName,
        l.adapter,
      ]),
    ).toEqual([['runs', 'manual']]);
  });

  it('the legacy checker and the scan were asked for none of them', () => {
    for (const source of [BARE_MANUAL, LISTEN_AS, CONNECT_MANUAL]) platform(source);
    expect(counters).toEqual({ checkProgram: 0, checkProgramWithLink: 0, scan: 0 });
  });

  it("the bare text pinned '4' is refused by the scan, the only case that asks the legacy checker", () => {
    const verdict = platform(BARE_MANUAL, '4');
    expect(verdict.ok).toBe(false);
    expect(verdict.diagnostics.find((d) => d.code === 'MOV_ENGINE_UNSUPPORTED')?.message).toContain(
      "a movement seeded from 'manual'",
    );
    expect(counters.scan).toBe(1);
    expect(counters.checkProgram + counters.checkProgramWithLink).toBeGreaterThan(0);
  });

  it('a pin from a newer line is the version diagnostic alone', () => {
    const verdict = platform(BARE_MANUAL, '0.13.0');
    expect(verdict.ok).toBe(false);
    expect(verdict.diagnostics).toHaveLength(1);
    expect(verdict.diagnostics[0].code).toMatch(/^MOV_LANGUAGE_VERSION/);
    expect(counters).toEqual({ checkProgram: 0, checkProgramWithLink: 0, scan: 0 });
  });
});

describe('the corpus never reaches the legacy checker', () => {
  it('every claim and example above, validated together, asks none of the legacy entries', () => {
    for (const claim of claims) {
      const files = claim.status === 'runs' ? claim.files : undefined;
      if (files) continue;
      platform(claim.probe);
    }
    for (const example of sectionExamples) platform(example.source);
    expect(counters).toEqual({ checkProgram: 0, checkProgramWithLink: 0, scan: 0 });
  });
});
