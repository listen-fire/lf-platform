// The replay of one corpus's recorded runs against the two targets, shared
// by engine_runs.v1 and engine_runs.v2 (see either for what it proves).
//
// Under UPDATE_ENGINE_RUNS=1 the replay checks the harvest instead of judging
// it: every recording must replay on the TypeScript engine both in process
// and over the HTTP double, save the ones a known reason accounts for
// (`UNPORTABLE`, each with its count per corpus), which are dropped from the
// fixture. Anything else fails the harvest, naming each recording and its
// first divergence. Run it straight after the harvest (`pnpm
// harvest:engine-runs` does both).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson, hostRecordingSchema, type HostRecording, type ReplayTarget, type ReplayVerdict } from 'engine-contracts/conformance';

import { httpTarget, typescriptTarget } from '../replay';
import { type LanguageVersion } from 'movement-lang';
import { PLATFORM_SUPPORTED_LANGUAGE_VERSIONS } from 'legacy-lang';

import { parsePinned } from '@listen-fire/legacy-engine/services/movement_engine/ts_program_check';

const FIXTURES = path.resolve(__dirname, '../__fixtures__');

/** The fewest recordings each corpus's fixture holds. The corpora are of
 *  versions 1 and 2, which run only on the TypeScript engine: the Rust
 *  engine's replays of them retired with its support for versions below 5
 *  (2026-10-16). */
const FLOORS = {
  v1: { recordings: 394 },
  v2: { recordings: 488 },
} as const;

const fixtureOf = (corpus: keyof typeof FLOORS): string => path.join(FIXTURES, `engine-runs.${corpus}.json`);

function linesOf(corpus: keyof typeof FLOORS): string[] {
  return readFileSync(fixtureOf(corpus), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function recordingOf(corpus: keyof typeof FLOORS, line: string, i: number): HostRecording {
  const parsed = hostRecordingSchema.safeParse(JSON.parse(line));
  if (!parsed.success) throw new Error(`engine-runs.${corpus}.json line ${i + 1}: ${parsed.error.message}`);
  return parsed.data;
}

function recordingsOf(corpus: keyof typeof FLOORS): HostRecording[] {
  return linesOf(corpus).map((line, i) => recordingOf(corpus, line, i));
}

/**
 * The recordings that cannot replay anywhere but where they were recorded,
 * by why — each a reason a recording cannot carry — and how many of each
 * corpus's recordings it accounts for. Asserted exactly: a new one, or one
 * fewer, fails the harvest until this says why.
 */
const UNPORTABLE: Array<{
  reason: string;
  matches: (recording: HostRecording, verdict: Extract<ReplayVerdict, { kind: 'diverged' | 'skipped' }>) => boolean;
  count: Record<keyof typeof FLOORS, number>;
}> = [
  {
    // An engine non-determinism not yet fixed: an extraction mints its call
    // sites' ids (`x:<node>#<n>`, part of the prompt) in the order its
    // concurrent sibling entities reach them, so a host that answers at
    // another speed sees another numbering. Matched only where the replayed
    // request is a recorded one but for its site ids.
    reason: 'an extraction numbers its call sites in the order concurrent sibling entities reach them',
    matches: (recording, verdict) => differsOnlyInSiteIds(recording, verdict),
    count: { v1: 2, v2: 2 },
  },
];

/** An extraction call site's id, as a prompt and its reply carry it. */
const SITE_ID = /x:[a-z0-9_]+#\d+/;
const maskSites = (text: string): string => text.replace(new RegExp(SITE_ID.source, 'g'), 'x:<site>');

/** True when the replay made a request with no recorded counterpart that a
 *  recorded request matches once both sides' call-site ids are masked. */
function differsOnlyInSiteIds(
  recording: HostRecording,
  verdict: Extract<ReplayVerdict, { kind: 'diverged' | 'skipped' }>,
): boolean {
  if (verdict.kind !== 'diverged' || verdict.unmatched === undefined) return false;
  const { path, args } = verdict.unmatched;
  const replayed = canonicalJson(args);
  if (!SITE_ID.test(replayed)) return false;
  return recording.requests.some(
    (request) => `${request.family}.${request.method}` === path && maskSites(canonicalJson(request.args)) === maskSites(replayed),
  );
}

/** Check the harvested fixture: every recording replays on the TypeScript
 *  engine in process and over the HTTP double, or a known reason accounts
 *  for it. Rewrites the fixture without the accounted ones. */
async function checkHarvest(corpus: keyof typeof FLOORS): Promise<void> {
  const kept: string[] = [];
  const unexplained: string[] = [];
  const accounted = new Map<string, number>();
  const http = await httpTarget();
  try {
    for (const [i, line] of linesOf(corpus).entries()) {
      const recording = recordingOf(corpus, line, i);
      const verdicts = [await typescriptTarget.replay(recording), await http.replay(recording)];
      const failed = verdicts.find((verdict) => verdict.kind !== 'same');
      if (failed === undefined) {
        kept.push(line);
        continue;
      }
      const divergence = failed.kind === 'diverged' ? failed.divergence : failed.reason;
      const known = UNPORTABLE.find((entry) => entry.matches(recording, failed));
      if (known === undefined) unexplained.push(`${label(recording, i)}: ${divergence}`);
      else accounted.set(known.reason, (accounted.get(known.reason) ?? 0) + 1);
    }
  } finally {
    await http.close();
  }
  expect(unexplained).toEqual([]);
  expect(Object.fromEntries(accounted)).toEqual(
    Object.fromEntries(UNPORTABLE.filter((entry) => entry.count[corpus] > 0).map((entry) => [entry.reason, entry.count[corpus]])),
  );
  const text = kept.join('\n') + '\n';
  writeFileSync(fixtureOf(corpus), text);
  console.log(`engine-runs.${corpus}.json: kept ${kept.length}, dropped ${[...accounted.values()].reduce((a, b) => a + b, 0)}, ${Buffer.byteLength(text)} bytes`);
}

/**
 * Recordings that encoded a behaviour since fixed as a bug, so a replay of
 * them diverges by design — each named, with how many of each corpus's
 * recordings it accounts for, asserted exactly (the corpora's triage, for
 * recordings). The recordings themselves are never edited. The harvest of
 * 2026-11-02 (listen-fire 0.13: catalogs of contract version 3, host families
 * version 2) recorded today's behaviour, so none encodes a fixed bug yet.
 */
const ENCODED_A_FIXED_BUG: Array<{
  reason: string;
  /** The recording is this one (its program and catalog say so), whether or
   *  not the target ran it: a target that skips it still accounts for it. */
  is: (recording: HostRecording) => boolean;
  /** The replay diverged exactly where the fixed bug says. */
  matches: (recording: HostRecording, divergence: string, verdict: Extract<ReplayVerdict, { kind: 'diverged' }>) => boolean;
  count: Record<keyof typeof FLOORS, number>;
}> = [];


const label = (recording: HostRecording, i: number): string =>
  `#${i + 1} ${recording.entry} ${JSON.stringify(recording.input.source.slice(0, 80))}`;

async function replayAll(target: ReplayTarget, recordings: readonly HostRecording[], corpus: keyof typeof FLOORS) {
  const diverged: string[] = [];
  const skipped = new Map<string, number>();
  const fixed = new Map<string, number>();
  const skippedFixed = new Map<string, number>();
  let same = 0;
  for (const [i, recording] of recordings.entries()) {
    const verdict = await target.replay(recording);
    switch (verdict.kind) {
      case 'same':
        same += 1;
        break;
      case 'skipped': {
        skipped.set(verdict.reason, (skipped.get(verdict.reason) ?? 0) + 1);
        // A recording that encoded a fixed bug, skipped: accounted for as
        // itself, never by another recording's skip.
        const known = ENCODED_A_FIXED_BUG.find((entry) => entry.is(recording));
        if (known !== undefined) skippedFixed.set(known.reason, (skippedFixed.get(known.reason) ?? 0) + 1);
        break;
      }
      case 'diverged': {
        const known = ENCODED_A_FIXED_BUG.find((entry) => entry.matches(recording, verdict.divergence, verdict));
        if (known !== undefined) fixed.set(known.reason, (fixed.get(known.reason) ?? 0) + 1);
        else diverged.push(`${label(recording, i)}: ${verdict.divergence}`);
        break;
      }
    }
  }
  const expected = Object.fromEntries(
    ENCODED_A_FIXED_BUG.filter((entry) => entry.count[corpus] > 0).map((entry) => [entry.reason, entry.count[corpus]]),
  );
  // Exactly the named ones, on every target: each recording that encoded a
  // fixed bug either diverged where the bug says or was skipped as itself.
  // Run, it must
  // diverge so: one that reproduces the old bug, or a new divergence, fails
  // until this says why.
  const accounted = Object.fromEntries(
    [...new Set([...fixed.keys(), ...skippedFixed.keys()])].map((reason) => [reason, (fixed.get(reason) ?? 0) + (skippedFixed.get(reason) ?? 0)]),
  );
  if (JSON.stringify(sortedKeys(accounted)) !== JSON.stringify(sortedKeys(expected))) {
    diverged.push(`the recordings that encoded a fixed bug were ${JSON.stringify(Object.fromEntries(fixed))} (skipped: ${JSON.stringify(Object.fromEntries(skippedFixed))}), not ${JSON.stringify(expected)}`);
  }
  return { same, skipped: Object.fromEntries(skipped), diverged };
}

const sortedKeys = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const HARVEST_CHECK_TIMEOUT_MS = 1_800_000;

export function replayCorpus(corpus: keyof typeof FLOORS): void {
  // Hundreds of whole runs per target.
  jest.setTimeout(600_000);
  if (process.env.UPDATE_ENGINE_RUNS === '1') {
    // The check replays the harvest twice over (in process and over the HTTP
    // double), which outgrows the replay suites' own limit.
    it(
      'every harvested recording replays on the TypeScript engine, or a known reason says why not',
      async () => {
        await checkHarvest(corpus);
      },
      HARVEST_CHECK_TIMEOUT_MS,
    );
    return;
  }
  const recordings = recordingsOf(corpus);
  let http: Awaited<ReturnType<typeof httpTarget>>;

  beforeAll(async () => {
    http = await httpTarget();
  });
  afterAll(async () => {
    await http.close();
  });

  it('are at least the floor', () => {
    expect(recordings.length).toBeGreaterThanOrEqual(FLOORS[corpus].recordings);
  });

  it('replay identically against the TypeScript engine in process', async () => {
    const { diverged } = await replayAll(typescriptTarget, recordings, corpus);
    expect(diverged).toEqual([]);
  });

  it('replay identically against the HTTP host double', async () => {
    const { diverged } = await replayAll(http, recordings, corpus);
    expect(diverged).toEqual([]);
  });
}
