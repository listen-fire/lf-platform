// Whether a run's segment runs on this release's engine (the Rust engine,
// `@listen-fire/engine`): it does when the pin's version is the current one. A
// version this build runs on its own engine (its lane) never reaches it, a
// version it holds or does not carry is refused in the registry's text, and a
// legacy id ('1'..'4') is refused with the remedy: this platform no longer
// carries the TypeScript engine that ran them. The refusal is this
// dispatcher's own, not a door's call order. No fallback between engines.

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';
import { isLegacyLanguageVersion } from 'legacy-lang';
import { capabilityOf, refusalOf, versionOf, type RunningCapability } from '@listen-fire/language-versions';
import { MovementEngineError } from 'movement-engine/public/errors';
import { neverAsAny } from 'movement-engine/public/types';

/** What a door that needs `needed` of a run pinned to a legacy id is told. */
export function legacyRunRefusal(pin: LanguageVersion, needed: RunningCapability): string {
  switch (needed) {
    case 'run':
    case 'listen':
      return `this automation is pinned to language version ${pin}, and this release starts no new run on versions 1 to 4: upgrade it to ${LANGUAGE_VERSION}`;
    case 'resume':
      return `this run is pinned to language version ${pin}, and this release carries no engine for versions 1 to 4, so it cannot continue: cancel it, then upgrade the automation to ${LANGUAGE_VERSION}`;
    default:
      return neverAsAny(needed);
  }
}

/** Why a run pinned to `languageVersion` does not get `needed` (a segment
 *  someone starts, by default) from this release's engine; undefined when it
 *  does. A version that provides `needed` on its own engine is refused here
 *  too: its runs go to its lane, never to this release's engine. */
export function heldRunRefusal(languageVersion: LanguageVersion, needed: RunningCapability = 'run'): string | undefined {
  if (isLegacyLanguageVersion(languageVersion)) return legacyRunRefusal(languageVersion, needed);
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
    default:
      return neverAsAny(capability);
  }
}

/** Refuses a run pinned to a version this release's engine does not provide
 *  `needed` for. A door that would start, resume or fire a program calls it
 *  before it reads the program's text, assembles a catalog for it or asks a
 *  model anything about it; the dispatcher calls it again itself. */
export function refuseHeldRun(languageVersion: LanguageVersion, needed: RunningCapability = 'run'): void {
  const refusal = heldRunRefusal(languageVersion, needed);
  if (refusal !== undefined) throw new MovementEngineError('MOVENG_LANGUAGE_VERSION', refusal);
}
