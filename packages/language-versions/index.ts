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
//     the release's own version, naming that release's packages exactly, its
//     façade `index.ts` (main `index`, shipping `**/*.js`: the image compiles
//     it where `pnpm deploy` installs it beside those packages);
//   - its entry below;
//   - a dependency on its package here, and one in `apps/api` (the api's build
//     vendors this registry into its own output, where an import of the
//     package resolves from the api's installed dependencies);
//   - `pnpm install`, for the lockfile.
// The image finds the package by its name (`deploy/Dockerfile`). A test holds
// every entry to this list (`__test__/wiring.unit.test.ts`).
//
// Each carried version has its own copy of the lane and of the platform's own
// modules as they stood at that release, by design: a shared file would
// resolve the wrong release's packages.
//
// Each entry says what it provides its pins, one capability each: checking,
// authoring help, running a segment someone starts, resuming a parked run, and
// firing its listens. Each is the current core's, the version's own through its
// package's façade, or held. A held capability refuses its pins with one text
// per capability (`refusalOf`), never handing them to another version.

import {
  LANGUAGE_VERSION,
  compatibilityKey,
  languageVersionDiagnostic,
  type Completions,
  type Definition,
  type HoverCard,
  type LanguageVersion,
} from 'movement-lang';

import type { StoryIR, StoryProblem, StoryValidityStatus } from 'legacy-lang';
import type { AdapterEventPhraseVocabulary, BrandIcon } from 'movement-engine/public/adapter';

import type { ListeningLane, ModulePlatform, ResumingLane, RunningLane } from './running';

export * from './running';

/** What a version's package set says about itself once loaded. */
export interface VersionPackages {
  readonly LANGUAGE_VERSION: string;
}

// ── What crosses into a carried version's checker: plain data only ──────────
//
// Never an object or a class of either release: TypeScript compares
// structurally, so a value of one release would pass silently into the other's
// functions. A version package states these same shapes in its own release's
// terms, and the compiler holds it to them where its entry loads it.

export type ConnectMethod = 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'app-only';

/** What the platform knows of a team that a carried version's catalog is
 *  built from. */
export interface TeamFacts {
  /** The team's stored credentials. */
  credentials: readonly {
    id: string;
    name: string;
    type: string;
    module?: { adapterType: string; credential: string };
  }[];
  /** The team's saved files, each with its own pin: what an import resolves
   *  against. */
  files: readonly { name: string; source: string; languageVersion: string }[];
  /** How a credential of `credentialType` is connected on the platform. */
  connectOf(credentialType: string): ConnectMethod;
  /** The store's change events arrive as a signed POST. */
  kgChangeWebhooks: boolean;
  /** The deployment lets a team connect MCP servers. */
  mcpEnabled: boolean;
  /** The shared WhatsApp number a manifest quotes, when one is set. */
  whatsappNumber: string | null;
  /** The team's installs of remote adapters: each install's stored manifest
   *  file, as JSON, which the carried version reads in its own terms. */
  remoteAdapters?: readonly { adapterType: string; manifest: unknown }[];
}

export interface LineCol {
  line: number;
  col: number;
}

export interface CheckedDiagnostic {
  code: string;
  message: string;
  /** The carried release's severity for its code. */
  severity: 'error' | 'warning' | 'info';
  span: { start: LineCol; end: LineCol };
  upgrade?: true;
  fix?: { edits: { span: { start: LineCol; end: LineCol }; text: string }[]; safe?: true };
}

export interface CheckedSource {
  diagnostics: CheckedDiagnostic[];
  /** The movement each `listen` fires, in file order. */
  firedMovements: string[];
  /** Each connected system the check could not read: the program is then
   *  unverified, never clean. */
  gaps: { adapter: string; detail: string }[];
  notes: string[];
}

export interface CheckRequest {
  source: string;
  /** The program's pin, on the carried version's key. */
  pin: LanguageVersion;
  team: TeamFacts;
  /** The platform's hosting of the version's modules, so the connected
   *  systems the program constructs are read; absent, each is a gap. */
  connected?: { teamId: string; modules: ModulePlatform };
}

export interface EditorRequest extends CheckRequest {
  /** A UTF-16 offset into `source`. */
  offset: number;
}

/** The words a program's systems declare in a carried version, for the
 *  platform's join: its display names, its brand marks and its event phrasing. */
export interface StoryWords {
  systems: Record<string, { label: string; icon: BrandIcon | null; eventPhrase?: AdapterEventPhraseVocabulary }>;
  /** What an instance schema calls a record type, by `<adapter>::<type>`. */
  recordLabels: Record<string, string>;
}

export interface StoryRequest extends CheckRequest {
  /** The automation's name, as the platform knows it. */
  name: string;
  /** The platform's stored ruling on the program, carried in. */
  validityStatus?: StoryValidityStatus;
}

/** A carried version's picture of a program: the projection is its own, over
 *  its own parse and story analysis, and only the plain result crosses. A text
 *  the version cannot read has no picture. */
export type CarriedStory =
  | { ok: true; story: StoryIR; words: StoryWords; gaps: { adapter: string; detail: string }[] }
  | { ok: false; problems: StoryProblem[] };

/** What a text's facets say about a file: whether it is an automation, a
 *  library, and whether a person can run it on demand. */
export interface FileFacets {
  listenerCount: number;
  runnableOnDemand: boolean;
  isAutomation: boolean;
  exportedMovementCount: number;
  exportedShapeCount: number;
  isLibrary: boolean;
}

export interface OutlinedListen {
  instance: string;
  configKey: string | null;
  /** Where it listens, as written; null for the form that names only its
   *  instance. */
  address: string | null;
  movement: string;
  startLine: number;
  endLine: number;
}

/** The listens a text declares and the facets they give it, read by the
 *  version's own parser: what a panel that manages listens needs, in text
 *  positions, with no syntax tree crossing. */
export interface ListenOutline {
  /** The live `listen` statements; null when the text does not parse. */
  active: (OutlinedListen & { adapter: string | null; traversal: boolean })[] | null;
  /** The commented-out ones. */
  paused: OutlinedListen[];
  /** Instance name to adapter key; null when the text does not parse. */
  adapters: Record<string, string> | null;
  facets: FileFacets;
}

/** A carried version's own checker and editor service. The editor's answers
 *  are the language service's shapes, which a carried version must answer in
 *  exactly. */
export interface CheckingLane {
  checkSource(request: CheckRequest): Promise<CheckedSource>;
  storyOf(request: StoryRequest): Promise<CarriedStory>;
  outlineOf(request: { source: string; pin: LanguageVersion }): ListenOutline;
  completionsAt(request: EditorRequest): Promise<Completions>;
  hoverAt(request: EditorRequest): Promise<HoverCard | null>;
  definitionAt(request: EditorRequest): Promise<Definition | null>;
}

/** What of the deployment decides the systems a carried version documents. */
export type DeploymentFacts = Pick<TeamFacts, 'kgChangeWebhooks' | 'mcpEnabled' | 'whatsappNumber'>;

/** The handbook a carried version's pins are taught from, as plain text. */
export interface CarriedHandbook {
  /** The handbook's own release. */
  release: string;
  frontPage: string;
  chapters: readonly { id: string; title: string; content: string }[];
  intentIndex: readonly { intent: string; chapter: string; section?: string }[];
}

export interface CarriedSearchResult {
  query: string;
  results: readonly {
    name: string;
    kind: string;
    purpose: string;
    detail: string;
    example?: string;
    anchor?: string;
  }[];
  note: string;
}

/** A team's systems as a carried version reads them. */
export interface SystemsRequest {
  team: TeamFacts;
  teamId: string;
  modules: ModulePlatform;
}

/** The catalog a carried version offers a program. */
export interface CarriedCatalogView {
  adapters: Record<string, object>;
  credentials: Record<string, object>;
  plugins: Record<string, object>;
  notes: string[];
}

/** A carried version's authoring help, in its own words. */
export interface HelpLane {
  handbookOf(deployment: DeploymentFacts): CarriedHandbook;
  /** One entry of the front page by its anchor. */
  handbookFrontSection(anchor: string): { ok: true; content: string } | { ok: false; error: string };
  searchHandbook(input: { query: string; kind?: 'function' | 'concept' | 'recipe' }, deployment: DeploymentFacts): CarriedSearchResult;
  catalogOf(team: TeamFacts): Promise<CarriedCatalogView>;
  /** One system, as compact text a program on this version is written against. */
  describeSystem(request: SystemsRequest & { system: string; connection?: string }): Promise<string>;
  /** Every system the team can use on this version, as compact text. */
  connectionsDigest(request: SystemsRequest): Promise<string>;
}

/**
 * Whether a carried version teaches its pins: its handbook, its language
 * search and its catalog.
 *
 * - `current`: the platform's own book and catalog do.
 * - `carried`: the version's own do, through its package.
 * - `held`: nothing teaches this version: a request for its help is refused,
 *   never answered from another version.
 */
export type HelpCapability = { kind: 'current' } | { kind: 'carried'; lane: () => Promise<HelpLane> } | { kind: 'held' };

/**
 * Whether a carried version checks its pins: checking, diagnostics, the story
 * and the editor.
 *
 * - `current`: the platform's own core checks them, imported directly.
 * - `carried`: the version's own checker does, through its package.
 * - `held`: the version is carried but does not check. Its pins are refused
 *   here exactly as the current language refuses a key it does not read.
 */
export type CheckCapability = { kind: 'current' } | { kind: 'carried'; lane: () => Promise<CheckingLane> } | { kind: 'held' };

/**
 * Whether a carried version runs a segment someone starts: Run now, a test
 * run, a validate-then-run.
 *
 * - `current`: the platform's own engine runs it.
 * - `carried`: the version's own engine and modules run it, through its
 *   package (`running.ts` states what crosses).
 * - `held`: the version is carried but does not run. Its runs are refused
 *   with the registry's text before anything reads the program.
 */
export type RunCapability = { kind: 'current' } | { kind: 'carried'; lane: () => Promise<RunningLane> } | { kind: 'held' };

/**
 * Whether a carried version resumes a run it parked: a timer, an ask, an await,
 * a callback's call, a limit pause, a race settling.
 *
 * - `current`: the platform's own run host and engine step it.
 * - `carried`: the version's own rules and engine do, over the platform's rows
 *   (`running.ts` states what crosses).
 * - `held`: the version does not resume: the resume is refused.
 */
export type ResumeCapability = { kind: 'current' } | { kind: 'carried'; lane: () => Promise<ResumingLane> } | { kind: 'held' };

/** Whether a carried version's listens fire: inbound deliveries, polls and
 *  schedules start its runs. `carried`: the version's own modules read each
 *  kept delivery and its own rules judge the automations pinned to it. `held`
 *  keeps its automations unprovisioned. */
export type ListenCapability = { kind: 'current' } | { kind: 'carried'; lane: () => Promise<ListeningLane> } | { kind: 'held' };

/** What a carried version provides its pins, one capability each. */
export interface Provided {
  readonly check: CheckCapability;
  readonly help: HelpCapability;
  readonly run: RunCapability;
  readonly resume: ResumeCapability;
  readonly listen: ListenCapability;
}

/** The capabilities whose absence refuses a run: what a door that would start,
 *  resume or fire a program asks for. Checking refuses by diagnostic instead. */
export type RunningCapability = 'run' | 'resume' | 'listen';

export interface CarriedVersion {
  /** The compatibility key every pin this entry serves shares. */
  readonly key: string;
  /** The exact release whose packages this build carries for the key. */
  readonly release: LanguageVersion;
  /** The legacy ids (from before the language was versioned by its release)
   *  that ran beside this release in production, so they share its key: an
   *  import between them and this release's programs is on one version.
   *  They are checked and run by the legacy packages, never by this entry's
   *  capabilities. */
  readonly legacyIds?: readonly LanguageVersion[];
  /** Loads the version's package set (lazily: an older line's wasm and engine
   *  are instantiated only when something asks for them). */
  load(): Promise<VersionPackages>;
  readonly provides: Provided;
  /** The version whose rows a trigger row on this key is: kept across a deploy
   *  whether or not its listens fire yet, and read only by it. */
  readonly listenRows?: () => Promise<ListeningLane>;
}

const HELD = { kind: 'held' } as const;
const CURRENT = { kind: 'current' } as const;

function keyOf(release: LanguageVersion): string {
  const key = compatibilityKey(release);
  if (key === undefined) throw new Error(`the language version registry names '${release}', which is not a release`);
  return key;
}

const CURRENT_VERSION: CarriedVersion = {
  // Read when asked, never when this module loads: a conformance corpus runs
  // the engine under a legacy id by making LANGUAGE_VERSION that id, and
  // importing the registry must not fail for it. A legacy id is no release, so
  // asking the current entry for its key under that setup is the one refusal.
  get key() {
    return keyOf(LANGUAGE_VERSION);
  },
  release: LANGUAGE_VERSION,
  load: async () => ({ LANGUAGE_VERSION }),
  provides: { check: CURRENT, help: CURRENT, run: CURRENT, resume: CURRENT, listen: CURRENT },
};

const CARRIED: readonly CarriedVersion[] = [
  CURRENT_VERSION,
  // Carried for the automations pinned to 0.12 and the runs 0.12 parked, so
  // they keep their own release's meaning after the platform moved on.
  {
    key: '0.12',
    release: '0.12.13',
    legacyIds: ['1', '2', '3', '4'],
    load: () => import('@listen-fire/lang-0.12'),
    provides: {
      check: { kind: 'carried', lane: () => import('@listen-fire/lang-0.12') },
      help: { kind: 'carried', lane: () => import('@listen-fire/lang-0.12') },
      run: { kind: 'carried', lane: () => import('@listen-fire/lang-0.12') },
      resume: { kind: 'carried', lane: () => import('@listen-fire/lang-0.12') },
      listen: { kind: 'carried', lane: () => import('@listen-fire/lang-0.12') },
    },
    listenRows: () => import('@listen-fire/lang-0.12'),
  },
];

let carriedByKey: ReadonlyMap<string, CarriedVersion> | undefined;

/** The entries by key, checked on first use: each filed under its release's key,
 *  none twice (see the current entry's key for why not at load). */
function byKey(): ReadonlyMap<string, CarriedVersion> {
  if (carriedByKey !== undefined) return carriedByKey;
  const entries = new Map<string, CarriedVersion>();
  for (const version of CARRIED) {
    if (keyOf(version.release) !== version.key) {
      throw new Error(`the language version registry files release ${version.release} under key ${version.key}`);
    }
    if (entries.has(version.key)) throw new Error(`the language version registry carries key ${version.key} twice`);
    entries.set(version.key, version);
  }
  carriedByKey = entries;
  return entries;
}

const BY_LEGACY_ID: ReadonlyMap<string, CarriedVersion> = (() => {
  const byId = new Map<string, CarriedVersion>();
  for (const version of CARRIED) {
    for (const id of version.legacyIds ?? []) {
      if (compatibilityKey(id) !== undefined) throw new Error(`the language version registry names release ${id} as a legacy id`);
      if (byId.has(id)) throw new Error(`the language version registry files legacy id ${id} twice`);
      byId.set(id, version);
    }
  }
  return byId;
})();

/** Every version this build carries, the current one first. */
export function carriedVersions(): readonly CarriedVersion[] {
  return CARRIED;
}

/** The entry for the platform's own core. */
export function currentVersion(): CarriedVersion {
  return CURRENT_VERSION;
}

/** The carried version a release pin belongs to, by its compatibility key;
 *  undefined for a pin whose key this build does not carry, a legacy id, or a
 *  text that is not a release. */
export function versionOf(pin: LanguageVersion): CarriedVersion | undefined {
  const key = compatibilityKey(pin);
  return key === undefined ? undefined : byKey().get(key);
}

/** The carried version whose key a legacy id shares (the release it ran
 *  beside in production); undefined for anything else. */
export function versionOfLegacyId(pin: LanguageVersion): CarriedVersion | undefined {
  return BY_LEGACY_ID.get(pin);
}

/** The key two pins are compared by when one program imports another: a
 *  release's compatibility key, the key of the release a legacy id ran
 *  beside, and the text itself for anything else (so it matches only
 *  itself). */
export function importKeyOf(pin: LanguageVersion): string {
  return versionOfLegacyId(pin)?.key ?? compatibilityKey(pin) ?? pin;
}

/** Whether `pin` is on the current version: the platform's own core reads
 *  it. */
export function isCurrent(pin: LanguageVersion): boolean {
  return versionOf(pin) === CURRENT_VERSION;
}

/** What `pin`'s version provides; everything held for a pin this build does
 *  not carry, so a caller has one refusal to write, not two. */
export function providedFor(pin: LanguageVersion): Provided {
  return versionOf(pin)?.provides ?? NOTHING_PROVIDED;
}

const NOTHING_PROVIDED: Provided = { check: HELD, help: HELD, run: HELD, resume: HELD, listen: HELD };

/** How `pin` is checked. */
export function checkingOf(pin: LanguageVersion): CheckCapability {
  return providedFor(pin).check;
}

/** How `pin` is taught. A legacy id was taught from the release it ran beside,
 *  and an upgrade is what moves it on. */
export function helpingOf(pin: LanguageVersion): { release: LanguageVersion; help: HelpCapability } | undefined {
  const version = versionOf(pin) ?? versionOfLegacyId(pin);
  return version === undefined ? undefined : { release: version.release, help: version.provides.help };
}

/** How a segment someone starts on `pin` runs. */
export function runningOf(pin: LanguageVersion): RunCapability {
  return providedFor(pin).run;
}

/** How a parked run of `pin` resumes. A run a legacy id pinned resumes on the
 *  legacy packages, and is not asked here. */
export function resumingOf(pin: LanguageVersion): ResumeCapability {
  return providedFor(pin).resume;
}

/** The version that keeps an await correlated to an adapter identity: only a
 *  version whose awaits parked on keys ever wrote one, so a wake naming a key
 *  is its to step. Undefined once no carried version does. */
export function correlatedAwaitsLane(): (() => Promise<ResumingLane>) | undefined {
  for (const version of CARRIED) {
    if (version.provides.resume.kind === 'carried') return version.provides.resume.lane;
  }
  return undefined;
}

/** The versions whose listens fire through their own lane, with it. */
export function carriedListeners(): ReadonlyArray<{ version: CarriedVersion; lane: () => Promise<ListeningLane> }> {
  return CARRIED.flatMap((version) => (version.provides.listen.kind === 'carried' ? [{ version, lane: version.provides.listen.lane }] : []));
}

/** Whether a trigger row on `pin` stays across a deploy as its version's listen. */
export function keepsListenRows(pin: LanguageVersion): boolean {
  return versionOf(pin)?.listenRows !== undefined;
}

/** Whether `pin`'s listens fire. */
export function listeningOf(pin: LanguageVersion): ListenCapability {
  return providedFor(pin).listen;
}

/** What a door asks of `pin`'s version, by the capability it needs. */
export function capabilityOf(pin: LanguageVersion, needed: RunningCapability): RunCapability | ResumeCapability | ListenCapability {
  switch (needed) {
    case 'run':
      return runningOf(pin);
    case 'resume':
      return resumingOf(pin);
    case 'listen':
      return listeningOf(pin);
    default: {
      const unknown: never = needed;
      throw new Error(`unknown capability ${JSON.stringify(unknown)}`);
    }
  }
}

/** What a capability is, as a refusal says it is not provided. */
const NOT_PROVIDED: Record<RunningCapability, string> = {
  run: 'run its automations',
  resume: 'resume its parked runs, so a run of it that parks is stopped where it parks',
  listen: 'fire its listens',
};

/**
 * What a door that needs `needed` of `pin`'s version is told when the version
 * does not provide it. One text per capability, given before anything reads
 * the program. A key this build does not carry at all is refused in the
 * language's own text, naming the remedy. A carried version names what it
 * provides and what it does not. Undefined when `needed` is provided.
 */
export function refusalOf(pin: LanguageVersion, needed: RunningCapability): string | undefined {
  const capability = capabilityOf(pin, needed);
  switch (capability.kind) {
    case 'current':
    case 'carried':
      return undefined;
    case 'held': {
      const version = versionOf(pin);
      if (version === undefined) {
        return (
          languageVersionDiagnostic(pin, LANGUAGE_VERSION)?.message ??
          `this automation pins language ${pin}, which this release (${LANGUAGE_VERSION}) does not read`
        );
      }
      return (
        `this automation pins language ${pin}: this platform carries ${version.release} to ${describeProvided(version.provides)}, ` +
        `but not to ${NOT_PROVIDED[needed]}; upgrade it to ${LANGUAGE_VERSION} for that`
      );
    }
    default: {
      const unknown: never = capability;
      throw new Error(`unknown capability ${JSON.stringify(unknown)}`);
    }
  }
}

/** What a run of `pin` started by someone is told when this build does not
 *  run it. */
export function runRefusal(pin: LanguageVersion): string | undefined {
  return refusalOf(pin, 'run');
}

/** What a resume of a run parked under `pin` is told, and what a segment of
 *  it that tries to park is stopped with, when this build does not resume it. */
export function resumeRefusal(pin: LanguageVersion): string | undefined {
  return refusalOf(pin, 'resume');
}

/** The capabilities a version provides, in words: "check and run", say. */
export function describeProvided(provides: Provided): string {
  const words: string[] = [];
  if (provides.check.kind !== 'held') words.push('check');
  if (provides.run.kind !== 'held') words.push('run');
  if (provides.resume.kind !== 'held') words.push('resume');
  if (provides.listen.kind !== 'held') words.push('fire the listens of');
  if (words.length === 0) return 'carry nothing of';
  if (words.length === 1) return `${words[0]} its automations`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]} its automations`;
}

/** What an automation on `pin` does until it is upgraded, in words, from what
 *  its version provides: an agent believing the wrong answer builds a second
 *  automation beside a live one, so the sentence follows the registry. */
export function untilUpgraded(pin: LanguageVersion): string {
  const provides = providedFor(pin);
  const listens = provides.listen.kind === 'held' ? 'its listens do not fire' : 'its listens keep firing';
  const waits = provides.resume.kind === 'held' ? 'a run of it that would wait (an ask, a pause) is stopped' : 'a run of it that waits (an ask, a pause) resumes';
  return `${listens}, and ${waits}`;
}

/** Plain flags for a surface (the web's version panel, the save pane): what
 *  `pin`'s version provides. */
export function providedFlagsFor(pin: LanguageVersion): { check: boolean; run: boolean; resume: boolean; listen: boolean } {
  const provides = providedFor(pin);
  return {
    check: provides.check.kind !== 'held',
    run: provides.run.kind !== 'held',
    resume: provides.resume.kind !== 'held',
    listen: provides.listen.kind !== 'held',
  };
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
