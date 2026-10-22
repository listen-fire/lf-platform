// Which engine a run's segment runs on: its pin. A legacy id ('1'..'4') runs
// on the TypeScript engine this package keeps; any other pin is a release's
// semver, run on the Rust engine (`@listen-fire/engine`) when the installed
// language reads it by its rule, and refused otherwise. No fallback between
// them.

import { LANGUAGE_VERSION, compatible, languageVersionDiagnostic, type LanguageVersion } from 'movement-lang';
import { isLegacyLanguageVersion } from 'legacy-lang';

import { MovementEngineError, PARKED_ON_TYPESCRIPT } from 'movement-engine/public/errors';

/** An engine: the one a run's segment runs on. */
export type EngineChoice = 'rust' | 'ts';

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
  if (!compatible(run.languageVersion, LANGUAGE_VERSION)) {
    throw new MovementEngineError(
      'MOVENG_LANGUAGE_VERSION',
      languageVersionDiagnostic(run.languageVersion, LANGUAGE_VERSION)?.message ??
        `this automation pins language ${run.languageVersion}, which this release (${LANGUAGE_VERSION}) does not read`,
    );
  }
  if (run.parkedOn === 'ts') {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `this run is pinned to language ${run.languageVersion}, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume`,
      { reason: PARKED_ON_TYPESCRIPT },
    );
  }
  return 'rust';
}
