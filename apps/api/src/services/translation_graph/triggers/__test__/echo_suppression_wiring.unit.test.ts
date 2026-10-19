/**
 * Echo-suppression dispatch-wiring tests (Phase 2).
 *
 * Same source-text idiom as `loop_guard_gate.unit.test.ts`: read the dispatcher
 * source directly (no DB) and pin the load-bearing guarantees so a refactor
 * can't silently drop them:
 *
 *  - the consult sits at the inbound boundary AFTER the loop-guard floor and
 *    BEFORE the engine runs, on the one dispatch path (a knowledge-graph change
 *    takes it too, through its work row);
 *  - `suppress` returns the `echo_suppressed` disposition and records (not
 *    drops) the stored receipt as suppressed;
 *  - `no-op` (flag on, adapter can't answer) fires as normal with a loud log;
 *  - the consult is skipped under dry-run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const READ = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', rel), 'utf-8');

const routerSrc = READ('services/translation_graph/triggers/router.ts');

describe('dispatchTriggerByIdEvent — echo-suppression wiring (external path)', () => {
  it('consults after the loop guard and before the engine runs', () => {
    const guardIdx = routerSrc.indexOf('applyLoopGuard(');
    const consultIdx = routerSrc.indexOf('consultEchoSuppression({');
    const movementIdx = routerSrc.indexOf('runMovementFiring(');
    expect(consultIdx).toBeGreaterThan(guardIdx);
    // The only execution path is the movement firing (the legacy
    // non-movement orchestration walk retired with the TG engine, kill-tg).
    expect(movementIdx).toBeGreaterThan(consultIdx);
  });

  it('suppression returns echo_suppressed and records the receipt (not drop)', () => {
    expect(routerSrc).toMatch(/disposition\.kind === 'suppress'/);
    expect(routerSrc).toMatch(/markTriggerEventSuppressed\(input\.storedEventId/);
    expect(routerSrc).toMatch(/droppedReason: 'echo_suppressed'/);
  });

  it('a no-op (flag on, unanswerable) is logged and falls through to fire', () => {
    expect(routerSrc).toMatch(/disposition\.kind === 'no-op'/);
    expect(routerSrc).toMatch(/suppress_self on but unanswerable/);
  });

  it('the consult is skipped under dry-run', () => {
    // The consult block opens with the same `if (!dryRun)` guard the floor uses.
    const consultIdx = routerSrc.indexOf('consultEchoSuppression({');
    const preceding = routerSrc.slice(0, consultIdx);
    expect(preceding.lastIndexOf('if (!dryRun)')).toBeGreaterThan(
      preceding.lastIndexOf('// ── OPT-IN ECHO-SUPPRESSION') - 200,
    );
  });
});
