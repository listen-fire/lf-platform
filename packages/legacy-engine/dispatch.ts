// A saved movement runs on the engine its pinned language version names
// (`engineFor`): 5 and later on the Rust engine (`@listen-fire/engine`), 1–4 on
// the TypeScript engine this package keeps. A parked run resumes by the same
// rule; a version-5 run the TypeScript engine parked has no engine to resume
// on and fails loudly. There is no fallback between the two.

import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import { refuseUnsupportedParkStateVersion, type CallbackBodyInput, type SettleRaceInput } from 'engine-contracts';
import * as rust from 'movement-engine/public/movement-engine';
import type { EngineHost } from 'movement-engine/public/host';

import * as typescript from './public/movement-engine';
import { engineFor } from './services/movement_engine/engine_choice';

export { RUST_ENGINE_FROM_VERSION, engineFor, type EngineChoice } from './services/movement_engine/engine_choice';

type MovementRunResult = rust.MovementRunResult;

export async function runMovement(input: rust.RunMovementInput): Promise<MovementRunResult> {
  return engineOf(input) === 'rust' ? rust.runMovement(input) : typescript.runMovement(input);
}

export async function resumeMovement(input: rust.ResumeMovementInput): Promise<MovementRunResult> {
  refuseUnsupportedParkStateVersion(input.state.version);
  return engineOf(input) === 'rust' ? rust.resumeMovement(input) : typescript.resumeMovement(input);
}

export async function settleRaceFrame(input: SettleRaceInput & { host: EngineHost }): Promise<MovementRunResult> {
  refuseUnsupportedParkStateVersion(input.state.version);
  return engineOf(input) === 'rust' ? rust.settleRaceFrame(input) : typescript.settleRaceFrame(input);
}

export async function fireCallbackBody(input: CallbackBodyInput & { host: EngineHost }): Promise<MovementRunResult> {
  refuseUnsupportedParkStateVersion(input.state.version);
  return engineOf(input) === 'rust' ? rust.fireCallbackBody(input) : typescript.fireCallbackBody(input);
}

/** The engine a segment of `input`'s run runs on: the run's pin, and, for a
 *  resume, the engine its row says parked it. */
function engineOf(input: { languageVersion?: rust.RunMovementInput['languageVersion']; parkedOnEngine?: 'ts' | 'rust' }) {
  return engineFor({
    languageVersion: input.languageVersion ?? CURRENT_LANGUAGE_VERSION,
    ...(input.parkedOnEngine !== undefined ? { parkedOn: input.parkedOnEngine } : {}),
  });
}
