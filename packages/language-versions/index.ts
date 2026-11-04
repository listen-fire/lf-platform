// The language versions this build carries, keyed by compatibility key (the
// minor under 0.x, the major from 1.0: movement-lang's `compatibilityKey`).
// An automation's pin chooses its version here, and nowhere else: checking
// and running ask the pin's entry what it provides, and a pin whose key no
// entry carries is refused as the current language refuses it.
//
// The current version is this build's own core, which the platform imports
// directly (the workspace catalog). Every other version is one package that
// names that release's packages at exact versions (`packages/lang-<version>`),
// reached only through this file: the boundary script refuses any other import
// of it, because TypeScript compares structurally and would let one version's
// values pass silently into another's functions, and each version's error
// classes are its own.
//
// Carrying another version takes, and only takes:
//   - its package, `packages/lang-<key>`, named `@listen-fire/lang-<key>` at
//     the release's own version, naming that release's packages exactly;
//   - its entry below;
//   - a dependency on its package here, and one in `apps/api` (the api's build
//     vendors this registry into its own output, where an import of the
//     package resolves from the api's installed dependencies);
//   - `pnpm install`, for the lockfile.
// The image finds the package by its name (`deploy/Dockerfile`). A test holds
// every entry to this list (`__test__/wiring.unit.test.ts`).
//
// A capability a version's entry does not provide is held: its pins are
// refused exactly as if the version were not carried, never handed to another
// version.

import { LANGUAGE_VERSION, compatibilityKey, neverAsAny, type LanguageVersion } from 'movement-lang';

/** What a version's package set says about itself once loaded. */
export interface VersionPackages {
  readonly LANGUAGE_VERSION: string;
}

/**
 * One capability of a carried version.
 *
 * - `current`: the platform's own core provides it, imported directly.
 * - `held`: the version is carried but does not provide it. Its pins are
 *   refused here exactly as the current language refuses a key it does not
 *   read. Never a fallback to another version.
 */
export type Capability = { kind: 'current' } | { kind: 'held' };

export interface CarriedVersion {
  /** The compatibility key every pin this entry serves shares. */
  readonly key: string;
  /** The exact release whose packages this build carries for the key. */
  readonly release: LanguageVersion;
  /** Loads the version's package set (lazily: an older line's wasm and engine
   *  are instantiated only when something asks for them). */
  load(): Promise<VersionPackages>;
  /** Checking, diagnostics, the story and the editor. */
  readonly check: Capability;
  /** Running a segment, resuming a parked run, settling a race frame. */
  readonly run: Capability;
}

const HELD: Capability = { kind: 'held' };
const CURRENT: Capability = { kind: 'current' };

function keyOf(release: LanguageVersion): string {
  const key = compatibilityKey(release);
  if (key === undefined) throw new Error(`the language version registry names '${release}', which is not a release`);
  return key;
}

const CURRENT_VERSION: CarriedVersion = {
  key: keyOf(LANGUAGE_VERSION),
  release: LANGUAGE_VERSION,
  load: async () => ({ LANGUAGE_VERSION }),
  check: CURRENT,
  run: CURRENT,
};

const CARRIED: readonly CarriedVersion[] = [
  CURRENT_VERSION,
  // Carried for the automations pinned to 0.12 and the runs 0.12 parked, so
  // they keep their own release's meaning after the platform moved on.
  {
    key: '0.12',
    release: '0.12.13',
    load: () => import('@listen-fire/lang-0.12'),
    check: HELD,
    run: HELD,
  },
];

const BY_KEY: ReadonlyMap<string, CarriedVersion> = (() => {
  const byKey = new Map<string, CarriedVersion>();
  for (const version of CARRIED) {
    if (keyOf(version.release) !== version.key) {
      throw new Error(`the language version registry files release ${version.release} under key ${version.key}`);
    }
    if (byKey.has(version.key)) throw new Error(`the language version registry carries key ${version.key} twice`);
    byKey.set(version.key, version);
  }
  return byKey;
})();

/** Every version this build carries, the current one first. */
export function carriedVersions(): readonly CarriedVersion[] {
  return CARRIED;
}

/** The entry for the platform's own core. */
export function currentVersion(): CarriedVersion {
  return CURRENT_VERSION;
}

/** The carried version a pin belongs to, by its compatibility key; undefined
 *  for a pin whose key this build does not carry, or that is not a release. */
export function versionOf(pin: LanguageVersion): CarriedVersion | undefined {
  const key = compatibilityKey(pin);
  return key === undefined ? undefined : BY_KEY.get(key);
}

/** What the version of `pin` provides for `capability`: `held` for a pin this
 *  build does not carry, so a caller has one refusal to write, not two. */
export function capabilityOf(pin: LanguageVersion, capability: 'check' | 'run'): Capability {
  const version = versionOf(pin);
  if (version === undefined) return HELD;
  switch (capability) {
    case 'check':
      return version.check;
    case 'run':
      return version.run;
    default:
      return neverAsAny(capability);
  }
}

/**
 * Loads every carried version and confirms each package set is the release
 * its entry names. A set that resolved to another release (a deploy that
 * vendored it beside the current core, say) fails here, by name, rather than
 * running one version's code on another's objects.
 */
export async function verifyCarriedVersions(): Promise<void> {
  for (const version of CARRIED) {
    const loaded = (await version.load()).LANGUAGE_VERSION;
    if (loaded !== version.release) {
      throw new Error(
        `language version ${version.key} should load release ${version.release}, but its packages are ${loaded}`,
      );
    }
  }
}
