/**
 * Loop-guard dispatch-gating wiring tests (Phase 1).
 *
 * Same source-text idiom as `run_mode_gate.unit.test.ts`: read the dispatcher
 * source directly (no DB) and pin the load-bearing guarantees so a future
 * refactor can't silently drop them:
 *
 *  - the guard is consulted INSIDE dispatch, AFTER the run_mode gate and BEFORE
 *    the movement firing runs (`runMovementFiring`);
 *  - an existing guard-pause skips the run (`loop_guard_paused`);
 *  - a rate throttle is QUEUE-DON'T-DROP (a stored receipt is held + replayed;
 *    no receipt → record-and-skip, explicitly NOT dropped);
 *  - observe mode does not enforce (the `enforced` branch);
 *  - the whole check fails open (try/catch → undefined / allow);
 *  - the guard is skipped under dry-run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const READ = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', rel), 'utf-8');

const src = READ('services/translation_graph/triggers/router.ts');

function extractFunction(source: string, name: string): string {
  let start = source.indexOf(`async function ${name}`);
  if (start === -1) start = source.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`function ${name} not found`);

  // Walk past the parameter list (which may contain `{...}` type literals) by
  // balancing parens from the signature's opening `(`, then take the body that
  // starts at the next `{`.
  let i = source.indexOf('(', start);
  let parenDepth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  let depth = 0;
  const open = source.indexOf('{', i);
  for (i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

describe('dispatchTriggerByIdEvent — loop-guard wiring', () => {
  const fn = extractFunction(src, 'dispatchTriggerByIdEvent');

  it('consults the guard after the run_mode gate and before the engine runs', () => {
    const gateIdx = fn.indexOf('runModeGate(triggerRow.runMode)');
    const guardIdx = fn.indexOf('applyLoopGuard(');
    const movementIdx = fn.indexOf('runMovementFiring(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(gateIdx);
    // The only execution path is the movement firing (the legacy
    // non-movement orchestration walk retired with the TG engine, kill-tg).
    expect(movementIdx).toBeGreaterThan(guardIdx);
  });

  it('returns early with the guard disposition (no engine run)', () => {
    expect(fn).toMatch(/if \(guardDisposition\) return \{ evaluations: \[\], droppedReason: guardDisposition \}/);
  });

  it('skips the guard under dry-run (a rehearsal can\'t loop in production)', () => {
    expect(fn).toMatch(/if \(!dryRun\) \{\s*const guardDisposition = await applyLoopGuard/);
  });

  it('feeds applied writes into the team external-write budget (post-run)', () => {
    expect(fn).toMatch(/recordExternalWrites\(\{/);
  });
});

describe('applyLoopGuard — pause / throttle / fail-open', () => {
  const fn = extractFunction(src, 'applyLoopGuard');

  it('honours an existing guard-pause by skipping the run', () => {
    expect(fn).toMatch(/loadGuardPausedState\(input\.triggerId\)/);
    expect(fn).toMatch(/return 'loop_guard_paused'/);
  });

  it('only enforces a pause when the decision is enforced (observe = pass-through)', () => {
    // The `!decision.enforced` guard before setGuardPaused is what makes
    // observe mode non-blocking.
    const pauseBranch = fn.slice(fn.indexOf("decision.kind === 'pause'"));
    expect(pauseBranch).toMatch(/if \(!decision\.enforced\) return undefined/);
    expect(pauseBranch).toMatch(/setGuardPaused\(/);
    expect(pauseBranch).toMatch(/notifyBreach\(/);
  });

  it('throttle is QUEUE-DON\'T-DROP: held+replayed with a receipt, record-and-skip without', () => {
    const throttleBranch = fn.slice(fn.indexOf("decision.kind === 'throttle'"));
    expect(throttleBranch).toMatch(/if \(!decision\.enforced\) return undefined/);
    // With a durable receipt → schedule a delayed re-dispatch (held, released).
    expect(throttleBranch).toMatch(/input\.storedEventId !== undefined/);
    expect(throttleBranch).toMatch(/scheduleDeferredReplay\(/);
    // Without one → degrade to record-and-skip, explicitly NOT dropped.
    expect(throttleBranch).toMatch(/record-and-skip/);
    expect(throttleBranch).toMatch(/return 'loop_guard_throttled'/);
  });

  it('exhaustively handles the decision kinds (neverAsAny)', () => {
    expect(fn).toMatch(/return neverAsAny\(decision\)/);
  });

  it('FAILS OPEN — a guard fault allows the run (returns undefined)', () => {
    expect(fn).toMatch(/catch \(err\)[\s\S]*failing open[\s\S]*return undefined/);
  });
});

describe('scheduleDeferredReplay — the held-event release', () => {
  const fn = extractFunction(src, 'scheduleDeferredReplay');

  it('puts the stored receipt back on the work queue, due after the delay — no in-process timer', () => {
    expect(fn).not.toMatch(/setTimeout\(/);
    expect(fn).toMatch(/requeueReceipt\(/);
    expect(fn).toMatch(/dueAt: new Date\(Date\.now\(\) \+ input\.delayMs\)/);
  });
});
