/**
 * run_mode dispatch-gating tests.
 *
 * Two halves:
 *
 *  1. Behavioural — `runModeGate` (the single source of truth the dispatch
 *     path consults; a knowledge-graph change takes the same path). Asserts off → drop, dry_run → dryRun true, live →
 *     dispatch with dryRun false. This is the load-bearing decision; the
 *     wiring tests below pin that the dispatcher actually consults it.
 *
 *  2. Wiring (source-text) — mirrors `r_routing.unit.test.ts`: reads the
 *     dispatcher sources directly (no DB) and pins that the gate is
 *     consulted, that `off` drops with a `run_mode_off` reason, and that
 *     `dry_run` threads `dryRun` into the engine step. Same idiom keeps the
 *     gating un-droppable by a future refactor.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runModeGate, parseRunMode } from '../run_mode';

const READ = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', rel), 'utf-8');

describe('runModeGate — off / dry_run / live semantics', () => {
  it('off → does not dispatch, with a run_mode_off reason', () => {
    const gate = runModeGate('off');
    expect(gate.dispatch).toBe(false);
    expect(gate).toMatchObject({ dispatch: false, droppedReason: 'run_mode_off' });
  });

  it('dry_run → dispatches with dryRun threaded true', () => {
    const gate = runModeGate('dry_run');
    expect(gate).toEqual({ dispatch: true, dryRun: true });
  });

  it('live → dispatches normally (dryRun false)', () => {
    const gate = runModeGate('live');
    expect(gate).toEqual({ dispatch: true, dryRun: false });
  });

  it('parseRunMode defaults unknown / null to live (never silently muted)', () => {
    expect(parseRunMode(null)).toBe('live');
    expect(parseRunMode(undefined)).toBe('live');
    expect(parseRunMode('garbage')).toBe('live');
    expect(parseRunMode('off')).toBe('off');
    expect(parseRunMode('dry_run')).toBe('dry_run');
    expect(parseRunMode('live')).toBe('live');
  });
});

describe('dispatchTriggerByIdEvent — run_mode gating wiring', () => {
  const src = READ('services/translation_graph/triggers/router.ts');

  it('consults runModeGate on the loaded trigger row', () => {
    expect(src).toMatch(/runModeGate\(triggerRow\.runMode\)/);
  });

  it('off → returns early dropped with the gate reason (before the movement firing)', () => {
    const fnRange = extractFunction(src, 'dispatchTriggerByIdEvent');
    // The gate's `dispatch:false` branch returns before `runMovementFiring`,
    // so an off trigger never fires. (The legacy non-movement orchestration
    // walk retired with the TG engine, kill-tg.)
    expect(fnRange).toMatch(/if \(!gate\.dispatch\)/);
    expect(fnRange).toMatch(/droppedReason: gate\.droppedReason/);
    const gateIdx = fnRange.indexOf('runModeGate(triggerRow.runMode)');
    const firingIdx = fnRange.indexOf('runMovementFiring(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(firingIdx).toBeGreaterThan(gateIdx);
  });

  it('dry_run|live → folds the gate dryRun into the threaded dryRun', () => {
    const fnRange = extractFunction(src, 'dispatchTriggerByIdEvent');
    // An explicit input.dryRun (test-run) OR a dry_run run_mode forces dry-run.
    expect(fnRange).toMatch(/const dryRun = input\.dryRun \|\| gate\.dryRun/);
    // …and the gated dryRun is threaded into the movement firing.
    expect(fnRange).toMatch(/runMovementFiring\(\{[\s\S]*?dryRun,/);
  });

  it('run_mode_off is a recognised droppedReason on the result type', () => {
    expect(src).toMatch(/\|\s*'run_mode_off'/);
  });
});


/**
 * Pull the body of a named function out of a source file — copy of the
 * helper in `r_routing.unit.test.ts` so the gating tests stay
 * self-contained (per-function assertions don't bleed across functions).
 */
function extractFunction(src: string, name: string): string {
  const declRe = new RegExp(
    `(?:async\\s+function\\s+${name}|function\\s+${name}|const\\s+${name}\\s*=\\s*(?:async\\s*)?\\()`,
  );
  const m = declRe.exec(src);
  if (!m) {
    throw new Error(`extractFunction: ${name} not found`);
  }
  const start = m.index;
  let i = start;
  let parenDepth = 0;
  let angleDepth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') parenDepth += 1;
    else if (c === ')') parenDepth -= 1;
    else if (c === '<' && parenDepth === 0) angleDepth += 1;
    else if (c === '>' && parenDepth === 0) angleDepth = Math.max(0, angleDepth - 1);
    else if (c === '{' && parenDepth === 0 && angleDepth === 0) break;
    i += 1;
  }
  if (i >= src.length) return src.slice(start, start + 500);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}
