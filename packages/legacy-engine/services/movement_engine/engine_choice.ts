// Which engine a run's segment runs on: its pin. A legacy id ('1'..'4') runs
// on the TypeScript engine this package keeps; any other pin is a release's
// semver, and its compatibility key chooses a carried version
// (`@listen-fire/language-versions`). The current version runs on the Rust
// engine (`@listen-fire/engine`). Every other pin is refused here: a version
// this build runs on its own engine (its lane) never reaches this one, and a
// version it holds or does not carry is refused in the registry's text. The
// refusal is this dispatcher's own, not a door's call order. No fallback
// between engines.

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';
import { isLegacyLanguageVersion } from 'legacy-lang';
import { capabilityOf, refusalOf, versionOf, type RunningCapability } from '@listen-fire/language-versions';
import { MovementEngineError, PARKED_ON_TYPESCRIPT } from 'movement-engine/public/errors';

/** An engine: the one a run's segment runs on. */
export type EngineChoice = 'rust' | 'ts';

/** Why a run pinned to `languageVersion` does not get `needed` (a segment
 *  someone starts, by default) from this release's engines; undefined when
 *  it does (a legacy id always does). A version that provides `needed` on its
 *  own engine is refused here too: its runs go to its lane, never to this
 *  release's engine. */
export function heldRunRefusal(languageVersion: LanguageVersion, needed: RunningCapability = 'run'): string | undefined {
  if (isLegacyLanguageVersion(languageVersion)) return undefined;
  const capability = capabilityOf(languageVersion, needed);
  switch (capability.kind) {
    case 'current':
      return undefined;
    case 'carried':
      return (
        `this automation pins language ${languageVersion}, which this platform runs on ${versionOf(languageVersion)?.release ?? languageVersion}'s own engine, ` +
        `never on this release's (${LANGUAGE_VERSION})`
      );
    case 'held':
      return refusalOf(languageVersion, needed);
    default: {
      const unknown: never = capability;
      throw new Error(`unknown capability ${JSON.stringify(unknown)}`);
    }
  }
}

/** Refuses a run pinned to a version this release's engines do not provide
 *  `needed` for. A door that would start, resume or fire a program on them
 *  calls it before it reads the program's text, assembles a catalog for it or
 *  asks a model anything about it; the dispatcher calls it again itself. */
export function refuseHeldRun(languageVersion: LanguageVersion, needed: RunningCapability = 'run'): void {
  const refusal = heldRunRefusal(languageVersion, needed);
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
  refuseHeldRun(run.languageVersion, run.parkedOn !== undefined ? 'resume' : 'run');
  if (run.parkedOn === 'ts') {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `this run is pinned to language ${run.languageVersion}, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume`,
      { reason: PARKED_ON_TYPESCRIPT },
    );
  }
  return 'rust';
}
