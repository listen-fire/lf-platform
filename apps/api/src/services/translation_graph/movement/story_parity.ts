// The story a release pin drew before the wasm's story analysis drew it, and
// the comparison that holds the two equal.
//
// Before, a release pin's picture was legacy-lang's projection of its own
// check under legacy-lang's dialect of the 0.12 surface, its verdict the
// wasm's. `legacyStoryUnder5` rebuilds exactly that without `storyOf`, which
// refuses that dialect now. `compareStories` reports every difference, except the ones
// ruled acceptable, which it counts.
//
// The rulings (PLAN-17):
//   R1  an extract field typed by a borrowed path has no type from the analysis;
//   R3  a positional plugin argument is named by the plugin's parameter, where
//       legacy wrote its ordinal;
//   R6  a movement's effect row lists its instances in another order;
//   R7  the analysis gives a hop a landing legacy did not (additions only);
//   R8  a movement calling one imported from a library file is partial, its
//       reads and writes a subset of legacy's: the analysis sees one file,
//       where legacy folded the callee in through the catalog's files.
// Extract descriptions (R2) and declared field types are recovered and must
// be equal. R4 and R5 were ruled but never met on the corpus, so they hold no
// normaliser.

import {
  LANGUAGE_VERSION,
  MovementParseError,
  RustCheckRefused,
  checkSourceInRust,
  fromCatalogSnapshot,
  resolveFileFromSnapshot,
  type CatalogSnapshot,
  type Diagnostic,
} from 'movement-lang';
import {
  checkProgramWithLink,
  parseProgram,
  projectStory,
  type StoryResult,
} from 'legacy-lang';

import { LEGACY_UPGRADE_DIALECT } from './language_route';

/**
 * The picture a release pin had before the analysis: legacy-lang's recording of
 * its own check under the 0.12 dialect, projected, carrying the wasm's verdict.
 */
export function legacyStoryUnder5(source: string, snapshot: CatalogSnapshot): StoryResult {
  let program;
  try {
    program = parseProgram(source, { languageVersion: LEGACY_UPGRADE_DIALECT });
  } catch (error) {
    if (!(error instanceof MovementParseError)) throw error;
    const span = { start: error.loc, end: error.loc };
    return { ok: false, reason: 'unparseable', problems: [{ code: 'MOV_PARSE', message: error.message, severity: 'error', span }] };
  }
  let diagnostics: Diagnostic[];
  try {
    diagnostics = checkSourceInRust(source, snapshot, { languageVersion: LANGUAGE_VERSION });
  } catch (error) {
    if (!(error instanceof RustCheckRefused)) throw error;
    const span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };
    return { ok: false, reason: 'unparseable', problems: [{ code: 'MOV_PARSE', message: error.message, severity: 'error', span }] };
  }
  const resolveFile = resolveFileFromSnapshot(snapshot);
  const { recording } = checkProgramWithLink(program, fromCatalogSnapshot(snapshot), {
    recordAnalysis: true,
    languageVersion: LEGACY_UPGRADE_DIALECT,
    ...(resolveFile !== undefined ? { resolveFile } : {}),
  });
  return {
    ok: true,
    story: projectStory({
      program,
      recording: recording ?? { frames: [], writes: [], nodes: [] },
      diagnostics,
      languageVersion: LEGACY_UPGRADE_DIALECT,
    }),
  };
}

export type StoryRuling = 'R1' | 'R3' | 'R6' | 'R7' | 'R8';

export interface StoryDifference {
  /** Where in the story, as a property path. */
  path: string;
  legacy: unknown;
  wasm: unknown;
}

export interface StoryComparison {
  /** Differences no ruling covers. Empty when the two stories are the same story. */
  differences: StoryDifference[];
  /** Differences a ruling accepted, each with the ruling that accepted it. */
  ruled: Array<StoryDifference & { ruling: StoryRuling }>;
}

export function compareStories(legacy: StoryResult, wasm: StoryResult): StoryComparison {
  const comparison: StoryComparison = { differences: [], ruled: [] };
  compare(legacy, wasm, [], comparison);
  return comparison;
}

/** Hits per ruling, over any number of comparisons. */
export function rulingHits(comparisons: StoryComparison[]): Record<StoryRuling, number> {
  const hits: Record<StoryRuling, number> = { R1: 0, R3: 0, R6: 0, R7: 0, R8: 0 };
  for (const comparison of comparisons) for (const ruled of comparison.ruled) hits[ruled.ruling] += 1;
  return hits;
}

function compare(legacy: unknown, wasm: unknown, path: Array<string | number>, into: StoryComparison): void {
  if (Object.is(legacy, wasm)) return;
  const ruling = rulingFor(legacy, wasm, path);
  if (ruling !== undefined) {
    into.ruled.push({ ruling, path: spell(path), legacy, wasm });
    return;
  }
  if (Array.isArray(legacy) && Array.isArray(wasm)) {
    if (legacy.length !== wasm.length) {
      into.differences.push({ path: `${spell(path)}.length`, legacy: legacy.length, wasm: wasm.length });
    }
    for (let i = 0; i < Math.min(legacy.length, wasm.length); i++) compare(legacy[i], wasm[i], [...path, i], into);
    return;
  }
  if (isRecord(legacy) && isRecord(wasm)) {
    for (const key of new Set([...Object.keys(legacy), ...Object.keys(wasm)])) {
      compare(legacy[key], wasm[key], [...path, key], into);
    }
    return;
  }
  into.differences.push({ path: spell(path), legacy, wasm });
}

function rulingFor(legacy: unknown, wasm: unknown, path: Array<string | number>): StoryRuling | undefined {
  const key = path[path.length - 1];
  const owner = path[path.length - 2];
  const parent = path[path.length - 3];
  // R1: an extract field's type, present in legacy only.
  if (key === 'type' && path.includes('tree') && parent === 'fields' && legacy !== undefined && wasm === undefined) {
    return 'R1';
  }
  // R3: a call argument legacy named by its ordinal, the analysis by its parameter.
  if (
    key === 'name' &&
    parent === 'args' &&
    typeof legacy === 'string' &&
    typeof wasm === 'string' &&
    /^\d+$/.test(legacy) &&
    !/^\d+$/.test(wasm)
  ) {
    return 'R3';
  }
  // R8: a movement's row, partial in the analysis only, doing no more than legacy's.
  if (key === 'effects' && isEffects(legacy) && isEffects(wasm) && partialSubset(legacy, wasm)) return 'R8';
  // R6: an effect row's instances, the same set in another order.
  if ((key === 'reads' || key === 'writes') && owner === 'effects' && reordered(legacy, wasm)) return 'R6';
  // R7: a hop's landing, given by the analysis only.
  if (key === 'landing' && (parent === 'path' || parent === 'hops') && legacy === undefined && wasm !== undefined) {
    return 'R7';
  }
  return undefined;
}

interface Effects {
  reads: unknown[];
  writes: unknown[];
  ai: unknown;
  now: unknown;
  suspend: unknown;
  partial: unknown;
}

function isEffects(value: unknown): value is Effects {
  return isRecord(value) && Array.isArray(value.reads) && Array.isArray(value.writes) && 'partial' in value;
}

function partialSubset(legacy: Effects, wasm: Effects): boolean {
  return (
    wasm.partial === true &&
    legacy.partial === false &&
    wasm.reads.every((r) => legacy.reads.includes(r)) &&
    wasm.writes.every((w) => legacy.writes.includes(w)) &&
    wasm.ai === legacy.ai &&
    wasm.now === legacy.now &&
    wasm.suspend === legacy.suspend
  );
}

/** The same distinct names, not in the same order. */
function reordered(legacy: unknown, wasm: unknown): boolean {
  if (!Array.isArray(legacy) || !Array.isArray(wasm) || legacy.length !== wasm.length) return false;
  const names = new Set(legacy);
  return (
    names.size === legacy.length &&
    wasm.every((name) => names.has(name)) &&
    legacy.some((name, i) => name !== wasm[i])
  );
}

function spell(path: Array<string | number>): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
