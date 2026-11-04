// Which engine a run's segment runs on: its pin. A legacy id ('1'..'4') runs
// on the TypeScript engine this package keeps; any other pin is a release's
// semver, and its compatibility key chooses a carried version
// (`@listen-fire/language-versions`). The current version runs on the Rust
// engine (`@listen-fire/engine`); a version this build carries without running
// it, and a key it does not carry, are refused alike, by the registry's text
// (the current language's). No fallback between them.

import type { LanguageVersion } from 'movement-lang';
import { isLegacyLanguageVersion } from 'legacy-lang';
import { runRefusal } from '@listen-fire/language-versions';
import { MovementEngineError, PARKED_ON_TYPESCRIPT } from 'movement-engine/public/errors';

/** An engine: the one a run's segment runs on. */
export type EngineChoice = 'rust' | 'ts';

/** Why a run pinned to `languageVersion` does not run on this build, in the
 *  registry's text; undefined when it runs (a legacy id always does). */
export function heldRunRefusal(languageVersion: LanguageVersion): string | undefined {
  return isLegacyLanguageVersion(languageVersion) ? undefined : runRefusal(languageVersion);
}

/** Refuses a run pinned to a version this build does not run. A door that
 *  would run a program calls it before it reads the program's text, assembles
 *  a catalog for it or asks a model anything about it. */
export function refuseHeldRun(languageVersion: LanguageVersion): void {
  const refusal = heldRunRefusal(languageVersion);
  if (refusal !== undefined) throw new MovementEngineError('MOVENG_LANGUAGE_VERSION', refusal);
}

/**
 * The engine a segment of a run pinned to `languageVersion` runs on.
 * `parkedOn` is, for a resume, the engine the run's row says parked it. A run
 * pinned to a release that the TypeScript engine parked (under the retired
 * MOVEMENT_ENGINE_V5_ON_TS switch) has no engine to resume on and fails
 * loudly. A legacy run that the Rust engine parked resumes on the TypeScript
 * engine, which reads the one park shape.
 */
export function engineFor(run: { languageVersion: LanguageVersion; parkedOn?: EngineChoice }): EngineChoice {
  if (isLegacyLanguageVersion(run.languageVersion)) return 'ts';
  refuseHeldRun(run.languageVersion);
  if (run.parkedOn === 'ts') {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `this run is pinned to language ${run.languageVersion}, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume`,
      { reason: PARKED_ON_TYPESCRIPT },
    );
  }
  return 'rust';
}
