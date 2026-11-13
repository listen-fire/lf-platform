// A saved movement's segment runs on this release's engine only when its pin
// allows it (./engine_choice.ts): there is one engine here, and no fallback. A
// parked run resumes by the same rule, and a release-pinned run the retired
// TypeScript engine parked has no engine to resume on and fails loudly.
//
// The pin is judged BEFORE the park state is read: a park state's version is
// the business of the version that wrote it, so a run parked under another
// version is answered by its own version (refused by pin while that version
// does not run) and never by this one's park-state reader.

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';
import { refuseUnsupportedParkStateVersion, type SettleRaceInput } from 'engine-contracts';
import * as rust from 'movement-engine/public/movement-engine';
import { MovementEngineError, PARKED_ON_TYPESCRIPT } from 'movement-engine/public/errors';
import type { EngineHost } from 'movement-engine/public/host';

import { refuseHeldRun } from './engine_choice';

export { heldRunRefusal, legacyRunRefusal, refuseHeldRun } from './engine_choice';

export async function runMovement(input: rust.RunMovementInput): Promise<rust.MovementRunResult> {
  refuseHeldRun(input.languageVersion ?? LANGUAGE_VERSION, 'run');
  return rust.runMovement(input);
}

export async function resumeMovement(input: rust.ResumeMovementInput): Promise<rust.MovementRunResult> {
  refuseResume(input);
  refuseUnsupportedParkStateVersion(input.state.version);
  return rust.resumeMovement(input);
}

export async function settleRaceFrame(input: SettleRaceInput & { host: EngineHost }): Promise<rust.MovementRunResult> {
  refuseResume(input);
  refuseUnsupportedParkStateVersion(input.state.version);
  return rust.settleRaceFrame(input);
}

/** Refuses a resume of `input`'s run unless its pin's version resumes here and
 *  this release's engine parked it. */
function refuseResume(input: { languageVersion?: LanguageVersion; parkedOnEngine?: 'ts' | 'rust' }): void {
  const languageVersion = input.languageVersion ?? LANGUAGE_VERSION;
  refuseHeldRun(languageVersion, 'resume');
  if (input.parkedOnEngine === 'ts') {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `this run is pinned to language ${languageVersion}, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume`,
      { reason: PARKED_ON_TYPESCRIPT },
    );
  }
}
