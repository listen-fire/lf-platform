// Which engine a run's segment runs on: its pinned language version. 5 and
// later run on the Rust engine (`@listen-fire/engine`), 1–4 on the TypeScript
// engine this package keeps. No fallback between them.

import { since, type LanguageVersion } from 'movement-lang';

import { MovementEngineError } from 'movement-engine/services/movement_engine/errors';
import { PARKED_ON_TYPESCRIPT } from 'movement-engine/services/movement_engine/rust_engine';

/** An engine: the one a run's segment runs on. */
export type EngineChoice = 'rust' | 'ts';

/** The first language version that runs on the Rust engine; every earlier
 *  one runs on the TypeScript engine. */
export const RUST_ENGINE_FROM_VERSION: LanguageVersion = 5;

/**
 * The engine a segment of a run pinned to `languageVersion` runs on.
 * `parkedOn` is, for a resume, the engine the run's row says parked it. A run
 * pinned to 5 or later that the TypeScript engine parked (under the retired
 * MOVEMENT_ENGINE_V5_ON_TS switch) has no engine to resume on and fails
 * loudly. A run pinned below 5 that the Rust engine parked resumes on the
 * TypeScript engine, which reads the one park shape.
 */
export function engineFor(run: { languageVersion: LanguageVersion; parkedOn?: EngineChoice }): EngineChoice {
  if (!since(run.languageVersion, RUST_ENGINE_FROM_VERSION)) return 'ts';
  if (run.parkedOn === 'ts') {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `this run is pinned to language version ${run.languageVersion}, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume`,
      { reason: PARKED_ON_TYPESCRIPT },
    );
  }
  return 'rust';
}
