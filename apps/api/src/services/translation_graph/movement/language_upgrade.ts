// A movement's language version pin moves ONLY by an explicit upgrade a person
// asks for (`upgradeMovement`): validation under the current version, shown to
// the caller first; the pin moves only when the caller acknowledges a clean
// result. Nothing moves a pin automatically (Henry, 2026-10-20).
//
// A pin is a legacy id ('1'..'4': the platform's TypeScript copy of the
// language reads it) or the semver of the language release it was written
// against, whose compatibility key chooses a version this platform carries
// (`@listen-fire/language-versions`). A current pin is judged by the wasm
// checker alone, against the run snapshot; a pin of an earlier line the
// platform carries, by that line's own checker; legacy-lang judges only the
// legacy ids (./language_route.ts).
//
// THE DEPLOY CHECK, once per release over every team's movements
// (`runDeployCheck`), only reports. A pin on the current version is `current`;
// one of an earlier line, which this platform does not run, is `stopped`,
// validated first under its own pin when its line's checker is carried; a
// newer release is `refused` with the rule's text, and `upgradeMovement` is
// how an older one moves. A legacy id is validated under its own pin, which must pass (the
// release preserves every legacy version's behaviour, so a failure there is a
// bug in that preservation), then under the installed language. Clean there — no errors, and no diagnostic the
// checker raised because the check is a move up (one marking a construct whose
// meaning changed) — makes the movement `upgradable`: offered the upgrade,
// pin untouched. Any other warning (a cost note, say) reads the same under
// either version: it is printed as a note and never blocks. Anything else
// stores what stood in the way on the movement and tells the team through a
// `Validation Issue`.
//
// The deploy check NEVER rewrites a movement's text either (Henry,
// 2026-10-16): it judges the text as written.
//
// Only the explicit upgrade REWRITES the text, by the fixes the checker offers
// under the current version (legacy-lang checker/upgrade.ts — the loop
// `listen-fire upgrade` runs too), from a legacy id and from a release pin of
// an older line alike: the fixes marked safe (they provably keep the meaning),
// and every fix when asked. What is judged is the rewritten text, and when the
// pin moves, the rewritten text is saved with it, in one save under the new
// pin. An error holds the pin, and so does a meaning-changed diagnostic whose
// rewrite was not applied (it is not proved to keep the meaning), and one with
// nothing to rewrite (the program may now do something else: a field whose
// meaning changed, an awaited value captured, a wait that may hang), until the
// author has checked it and asks for every fix. A movement held keeps its
// text and its pin; what is left is reported against the rewritten text
// (`upgradedSource`), each with its source line.
//
// An import is allowed only between files on the same version
// (./imports_across_versions.ts), so the upgrade moves the movement's whole
// import group: every automation and library on its version connected to it
// by imports. Every member is rewritten and checked, libraries first; the group
// moves only when all are clean, and otherwise nothing moves and the members
// that cannot are named. An upgrade never stops an importer.
//
// An edit or re-save never moves the pin (store.ts).
//
// See plans/language-versioning-2026-09-29/1_design.md, "Deploy check".

import {
  LANGUAGE_VERSION,
  neverAsAny,
  languageVersionDiagnostic as releaseVersionDiagnostic,
  languageVersionStanding as releaseVersionStanding,
  type LanguageVersion,
  type Diagnostic,
} from 'movement-lang';
import {
  PLATFORM_DEPRECATED_LANGUAGE_VERSIONS,
  PLATFORM_SUPPORTED_LANGUAGE_VERSIONS,
  isLegacyLanguageVersion,
  upgradeSourceAsync,
} from 'legacy-lang';
import { checkingOf, isCurrent, listeningOf, refusalOf, versionOf } from '@listen-fire/language-versions';
import { logger } from 'movement-engine/public/log';
import {
  DEPRECATED_VERSION,
  RELEASE_APPLIED,
  VALIDATION_ISSUE,
  type SystemEventKind,
} from '@listen-fire/system';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TeamFacts } from '@listen-fire/language-versions';
import { movementCatalogForTeam, type ImportedFile } from './catalog';

import { getAutomationsQb } from '../../../lib/kysely';
import { settleRunsParkedOnTriggers } from '../../interaction/run_failure';
import {
  automationUrl,
  automationsUrl,
  recordSystemEvent,
  type SystemEventPayload,
} from '../adapters/system/events';
import {
  assessMovementValidity,
  toAuthoringDiagnostic,
  validateMovementForTeam,
  type AuthoringDiagnostic,
  type TeamMovementValidation,
} from './authoring';
import { teamFactsOncePerTeam } from './carried_check';
import { withTeamContext } from './firing_context';
import { currentContext } from '../../context';
import { importGroupOf } from './imports_across_versions';
import { bringUpListensLater } from './listens_up';
import { saveMovement } from './provision';
import {
  getMovementRow,
  listAllMovementRows,
  listMovementRows,
  recordUpgradeCheck,
  recordValidityOutcome,
  type MovementRow,
} from './store';
import { movementSourceHash } from './version_store';

// ── What a validation says about a pin ──────────────────────────────────────

/** The diagnostics that keep a pin where it is: errors, and the ones the
 *  checker tagged as marking a construct whose meaning changed between the
 *  versions. Any other warning or info says nothing about the move. */
export function blockingDiagnostics(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error' || d.upgrade === true);
}

/** What `upgradeMovement` refuses outright, as `listen-fire upgrade` holds
 *  the pin: an error; a move-up diagnostic whose rewrite was left unapplied
 *  (not proved to keep the meaning); and a move-up warning with nothing to
 *  rewrite, which says the program may now do something else, since moving
 *  the pin is what puts it live under the new meaning. `all` (the author
 *  asked for every fix, having checked them: `listen-fire upgrade --all`)
 *  applied the first kind and lets the second pass, so an error alone holds
 *  it then. */
function holdsThePin(diagnostics: AuthoringDiagnostic[], all: boolean): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error' || (d.upgrade === true && (d.fix !== undefined || !all)));
}

/** The warnings under the newer version that do NOT block the move — shown
 *  beside the outcome so nothing is hidden, never stored as upgrade
 *  diagnostics. */
function noteDiagnostics(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'warning' && d.upgrade !== true);
}

function errorsOf(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
}

/** The validation seam the check and the upgrade share — the real one checks
 *  against the team's live catalog. `upgradingFrom` is set exactly when this
 *  is an UPGRADE check (see `validationUnder`). */
export type ValidateUnder = (input: {
  movement: MovementRow;
  languageVersion: LanguageVersion;
  upgradingFrom?: LanguageVersion;
  /** The text to validate, when it is not the movement's own (the upgrade's
   *  rewrite of it). */
  source?: string;
  /** The members of its import group already checked for the move, by name,
   *  as they will be once moved: what its imports of them resolve to. */
  movingWith?: ReadonlyMap<string, ImportedFile>;
}) => Promise<Pick<TeamMovementValidation, 'diagnostics' | 'gaps'>>;

/** What moving a pin did. Moving it is a save, which can still land short of
 *  shipping. */
export type AdvanceOutcome = { ok: true } | { ok: false; detail: string };

/** One member's move, ready to run inside the group's transaction: database
 *  writes only. */
export type MoveMember = () => Promise<AdvanceOutcome>;

/** Prepares moving `movement` to `to`, saved as `source` (the rewrite, or its
 *  own text when the rewrite changed nothing). The preparing runs before the
 *  group's transaction opens and makes every provider read the move needs.
 *  `movingWith` is the members moving before it, as they will be moved. Only an
 *  explicit upgrade calls it. */
export type Advance = (input: {
  movement: MovementRow;
  to: LanguageVersion;
  source: string;
  movingWith: ReadonlyMap<string, ImportedFile>;
}) => Promise<MoveMember>;

// ── The rewrite ─────────────────────────────────────────────────────────────

/** The movement's text rewritten for `to`, and the validation of the result. */
export interface UpgradeRewrite {
  source: string;
  changed: boolean;
  validation: Pick<TeamMovementValidation, 'diagnostics' | 'gaps'>;
}

/** An authoring diagnostic back in the checker's terms — what the upgrade
 *  loop reads its fixes from. */
function checkerDiagnostic(d: AuthoringDiagnostic): Diagnostic {
  return {
    code: d.code,
    message: d.message,
    span: { start: { line: d.line, col: d.col }, end: { line: d.endLine, col: d.endCol } },
    ...(d.severity !== 'error' ? { severity: d.severity } : {}),
    ...(d.upgrade === true ? { upgrade: true } : {}),
    ...(d.fix !== undefined
      ? {
          fix: {
            edits: d.fix.edits.map((e) => ({
              span: { start: { line: e.line, col: e.col }, end: { line: e.endLine, col: e.endCol } },
              text: e.text,
            })),
            ...(d.fix.safe === true ? { safe: true as const } : {}),
          },
        }
      : {}),
  };
}

/**
 * Rewrite `movement`'s text by the fixes a validation under `to` offers, until
 * none is left (movement-lang `upgradeSourceAsync`), and return the rewrite
 * with the validation of its final text. A text with nothing to rewrite costs
 * the one validation it always needed.
 *
 * Only fixes marked safe (they provably keep the meaning) are applied unless
 * `all` is set. An unapplied fix stays on its diagnostic, so the caller lists
 * it. Only an explicit upgrade rewrites; the deploy check never calls this.
 */
export async function rewriteForUpgrade(input: {
  movement: MovementRow;
  to: LanguageVersion;
  validate: ValidateUnder;
  all?: boolean;
  movingWith?: ReadonlyMap<string, ImportedFile>;
}): Promise<UpgradeRewrite> {
  const validations = new Map<string, Pick<TeamMovementValidation, 'diagnostics' | 'gaps'>>();
  const result = await upgradeSourceAsync(input.movement.source, async (source) => {
    const validation = await input.validate({
      ...validationUnder(input.movement, input.to),
      ...(source !== input.movement.source ? { source } : {}),
      ...(input.movingWith !== undefined && input.movingWith.size > 0 ? { movingWith: input.movingWith } : {}),
    });
    validations.set(source, validation);
    return validation.diagnostics.map(checkerDiagnostic);
  }, { all: input.all === true });
  const validation = validations.get(result.source);
  if (validation === undefined) throw new Error('the upgrade loop answered a text it never validated');
  return { source: result.source, changed: result.changed, validation };
}

/** Whether checking a movement pinned to `pin` under `target` is a check for
 *  a move up: a legacy id moving to a later legacy id or to any release, or a
 *  release pin moving to a release of a later line. */
export function movesUp(pin: LanguageVersion, target: LanguageVersion): boolean {
  if (isLegacyLanguageVersion(pin)) return !isLegacyLanguageVersion(target) || Number(pin) < Number(target);
  return !isLegacyLanguageVersion(target) && releaseVersionStanding(pin, target) === 'olderKey';
}

/** A validation of `movement` under `languageVersion`. A move up from the
 *  movement's pin (`movesUp`) makes it an UPGRADE check: the checker is told
 *  the pin and then also warns on the constructs whose meaning changed between
 *  the two — which is what keeps an unsafe pin from advancing. A check under
 *  the pin itself is an ordinary one. */
export function validationUnder(
  movement: MovementRow,
  languageVersion: LanguageVersion,
): Parameters<ValidateUnder>[0] {
  return movesUp(movement.languageVersion, languageVersion)
    ? { movement, languageVersion, upgradingFrom: movement.languageVersion }
    : { movement, languageVersion };
}

/** At most this many diagnostics are spelled out in an event's reason; the
 *  automation's page shows them all. */
const REASON_DIAGNOSTICS = 5;

function diagnosticsText(diagnostics: AuthoringDiagnostic[]): string {
  const shown = diagnostics
    .slice(0, REASON_DIAGNOSTICS)
    .map((d) => `line ${d.line}: ${d.message}`)
    .join('; ');
  const more = diagnostics.length - REASON_DIAGNOSTICS;
  return more > 0 ? `${shown}; and ${more} more` : shown;
}

// ── The deploy check ─────────────────────────────────────────────────────────

/** What the check found for one movement. It never moves a pin. */
export type DeployCheckOutcome =
  /** A legacy id clean under the installed language as written: offered the
   *  upgrade, the pin stays until someone asks for it. */
  | 'upgradable'
  /** A release pin the installed language reads, and validates under it. */
  | 'current'
  /** A legacy id that validates under its pin but not cleanly under the
   *  installed language: the pin stays, the diagnostics are stored, a
   *  `Validation Issue` is emitted. */
  | 'warned'
  /** A release pin of an older compatibility key: the installed language
   *  refuses it by name, so its listens are unprovisioned and it does not
   *  fire until someone upgrades it (ruling 2). The pin stays. */
  | 'stopped'
  /** A release pin the installed language does not read because it is newer,
   *  or a legacy id that does not validate under its own pin (the release
   *  failed to preserve that version's behaviour). The pin stays. */
  | 'refused'
  /** Could not be checked (a connected system could not be read, or the check
   *  itself failed): the pin stays and nothing is claimed. */
  | 'unverified';

export const DEPLOY_CHECK_OUTCOMES: readonly DeployCheckOutcome[] = [
  'upgradable',
  'current',
  'warned',
  'stopped',
  'refused',
  'unverified',
];

/** A version as the deploy check and the upgrade report it: the pin itself.
 *  `name` repeats it for one release (0.13 drops it), for readers of
 *  the old `{ version, name }` shape. */
export interface VersionView {
  version: LanguageVersion;
  name: string;
}

export function versionView(version: LanguageVersion): VersionView {
  return { version, name: version };
}

export interface DeployCheckEntry {
  id: string;
  teamId: string;
  name: string;
  outcome: DeployCheckOutcome;
  /** The movement's pin, which the check leaves where it is. */
  from: VersionView;
  /** The version an upgrade would move it to: the installed one when
   *  `upgradable`, otherwise the pin. */
  to: VersionView;
  /** Whether the pin is one the release deprecates. */
  deprecated: boolean;
  /** What stands in the way of an upgrade: the blocking diagnostics, or what
   *  went wrong. */
  detail: string;
  /** Warnings under the current version that would not block an upgrade. Absent
   *  when there were none (and on summaries recorded before v0.8.1). */
  notes?: string;
}

export interface DeployCheckSummary {
  release: string;
  languageRelease: string;
  current: VersionView;
  ranAt: string;
  counts: Record<DeployCheckOutcome, number>;
  automations: DeployCheckEntry[];
}

/** The languages a platform release reads: the installed language's
 *  version, the legacy ids it still runs, and those of them it deprecates. */
export interface PlatformLanguageRelease {
  current: LanguageVersion;
  legacy: ReadonlySet<LanguageVersion>;
  deprecated: ReadonlySet<LanguageVersion>;
}

/** The release a check ran for: the release tag AND the languages it reads,
 *  so an untagged build (`dev`) that changes the language is swept again
 *  rather than taken for one already done. */
export interface DeployCheckRelease {
  tag: string;
  language: PlatformLanguageRelease;
}

export function languageReleaseKey(release: PlatformLanguageRelease): string {
  const list = (set: ReadonlySet<LanguageVersion>) => [...set].sort().join(',');
  // Deprecating a legacy id changes what the sweep tells a team, so it changes
  // the key; with none deprecated the key leaves the part out.
  const deprecated = release.deprecated.size > 0 ? `;deprecated=${list(release.deprecated)}` : '';
  return `current=${release.current};legacy=${list(release.legacy)}${deprecated}`;
}

export interface DeployCheckDeps {
  release: DeployCheckRelease;
  /** Whether a check already ran for this release. */
  alreadyRan(input: { tag: string; languageRelease: string }): Promise<boolean>;
  listMovements(): Promise<MovementRow[]>;
  validate: ValidateUnder;
  /** The content hash validity records name their source by. */
  sourceHash(source: string): string;
  /** Store a validation as the movement's validity under `checkedAgainst`. */
  recordValidity(input: {
    movement: MovementRow;
    validation: Pick<TeamMovementValidation, 'diagnostics' | 'gaps'>;
    checkedAgainst: LanguageVersion;
  }): Promise<void>;
  recordUpgradeCheck(input: {
    movement: MovementRow;
    diagnostics: AuthoringDiagnostic[];
    checkedAgainst: LanguageVersion;
  }): Promise<void>;
  emit(input: { teamId: string; kind: SystemEventKind; payload: SystemEventPayload }): Promise<void>;
  /** Remove a movement's listens, so it fires nothing (an automation the
   *  installed language refuses). Its runs' history stays. */
  unprovision(movement: MovementRow): Promise<void>;
  /** Record the run — what makes a second run on this release a no-op. */
  recordRun(input: { tag: string; languageRelease: string; summary: DeployCheckSummary }): Promise<void>;
  now(): Date;
}

/**
 * Sweep every saved movement once for this release. Returns null when this
 * release was already swept. Never throws for one movement's sake: a movement
 * the check cannot finish is `unverified`, and the sweep goes on.
 */
export async function runDeployCheck(deps: DeployCheckDeps): Promise<DeployCheckSummary | null> {
  const { release } = deps;
  const languageRelease = languageReleaseKey(release.language);
  if (await deps.alreadyRan({ tag: release.tag, languageRelease })) return null;

  const at = deps.now().toISOString();
  const current = release.language.current;
  const entries: DeployCheckEntry[] = [];

  for (const movement of await deps.listMovements()) {
    let entry: DeployCheckEntry;
    try {
      entry = await checkOne({ deps, movement, current, at });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[DeployCheck] could not check an automation — its pin stays', {
        movementId: movement.id,
        teamId: movement.teamId,
        error: message,
      });
      entry = entryFor(movement, 'unverified', movement.languageVersion, release.language, message);
    }
    entries.push(entry);
  }

  const summary: DeployCheckSummary = {
    release: release.tag,
    languageRelease,
    current: versionView(current),
    ranAt: at,
    counts: countOutcomes(entries),
    automations: entries,
  };

  // One per workspace that has automations — a listener lives in a team, and
  // a team is told only about its own.
  for (const teamId of [...new Set(entries.map((e) => e.teamId))]) {
    const teams = entries.filter((e) => e.teamId === teamId);
    const counts = countOutcomes(teams);
    const stopped = teams.filter((e) => e.outcome === 'stopped').map((e) => e.name);
    await emitSafely(deps, () => ({
      teamId,
      kind: RELEASE_APPLIED,
      payload: {
        automation: '',
        automationId: '',
        runId: '',
        version: summary.current.name,
        reason: releaseAppliedReason(release.tag, current, counts, stopped),
        url: automationsUrl(),
        at,
      },
    }));
  }

  await deps.recordRun({ tag: release.tag, languageRelease, summary });
  return summary;
}

async function checkOne(input: {
  deps: DeployCheckDeps;
  movement: MovementRow;
  current: LanguageVersion;
  at: string;
}): Promise<DeployCheckEntry> {
  const { deps, movement, current, at } = input;
  const releaseLanguage = deps.release.language;
  const pin = movement.languageVersion;

  if (!isLegacyLanguageVersion(pin)) return checkReleasePin({ deps, movement, current, at });

  // (a) Under its own pin — what it runs as today. It must pass.
  const underPin = await deps.validate(validationUnder(movement, pin));
  await deps.recordValidity({ movement, validation: underPin, checkedAgainst: pin });
  const pinErrors = errorsOf(underPin.diagnostics);
  if (pinErrors.length > 0) {
    // Text already recorded as failing under this same version was broken
    // before the release (saved with errors, or a connected system changed
    // shape) — the release preserved it faithfully. Anything else is a
    // release that failed to preserve a version's behaviour.
    const alreadyFailing =
      movement.validityStatus === 'invalid' &&
      movement.validityCheckedAgainst === pin &&
      movement.validitySourceHash === deps.sourceHash(movement.source);
    const log = {
      movementId: movement.id,
      teamId: movement.teamId,
      name: movement.name,
      languageVersion: pin,
      diagnostics: pinErrors,
    };
    if (alreadyFailing) {
      logger.warn('[DeployCheck] an automation that already failed validation still does', log);
    } else {
      logger.error(
        '[DeployCheck] PRESERVATION FAILURE: an automation no longer validates under its own language version',
        log,
      );
    }
    const detail = `${alreadyFailing ? 'already failing before this release: ' : ''}${diagnosticsText(pinErrors)}`;
    await emitSafely(deps, () => ({
      teamId: movement.teamId,
      kind: VALIDATION_ISSUE,
      payload: payloadFor(movement, current, at, {
        reason:
          `Does not validate under its own language version ${describeVersion(pin)} ` +
          `after release ${deps.release.tag}: ${detail}`,
      }),
    }));
    await emitDeprecation(deps, movement, pin, at);
    return entryFor(movement, 'refused', pin, releaseLanguage, detail);
  }

  // (b) Under the current version, as written — whether an upgrade is on
  // offer. The check never rewrites the text: an old spelling blocks like any
  // error, and the explicit upgrade is what rewrites it.
  const underCurrent = await deps.validate(validationUnder(movement, current));
  const blocking = blockingDiagnostics(underCurrent.diagnostics);
  await deps.recordUpgradeCheck({ movement, diagnostics: blocking, checkedAgainst: current });
  const notes = noteDiagnostics(underCurrent.diagnostics);
  const withNotes = (entry: DeployCheckEntry): DeployCheckEntry =>
    notes.length > 0 ? { ...entry, notes: diagnosticsText(notes) } : entry;

  if (blocking.length > 0) {
    const detail = diagnosticsText(blocking);
    // Some of it has a rewrite the checker offers: an explicit upgrade applies it.
    const upgradable = blocking.some((d) => d.fix !== undefined);
    await emitSafely(deps, () => ({
      teamId: movement.teamId,
      kind: VALIDATION_ISSUE,
      payload: payloadFor(movement, current, at, {
        reason:
          `Stays on ${describeVersion(pin)}: under ${describeVersion(current)} ` +
          `it reports ${detail}` +
          (upgradable ? '. Upgrading the automation rewrites what the checker can fix, for you to review' : ''),
      }),
    }));
    await emitDeprecation(deps, movement, pin, at);
    return withNotes(entryFor(movement, 'warned', pin, releaseLanguage, detail));
  }
  if (underCurrent.gaps.length > 0) {
    await emitDeprecation(deps, movement, pin, at);
    return withNotes(entryFor(movement, 'unverified', pin, releaseLanguage, gapsText(underCurrent.gaps)));
  }

  // Clean as written: offered, never applied — only an explicit upgrade moves
  // a pin (Henry, 2026-10-20).
  await emitDeprecation(deps, movement, pin, at);
  return withNotes(entryFor(movement, 'upgradable', current, releaseLanguage, ''));
}

/**
 * A release pin: what the registry of carried versions says of it
 * (`@listen-fire/language-versions`). A pin whose version fires its listens is
 * validated under it and stays provisioned, `current` when clean of errors. A
 * pin of an earlier line whose listens this platform does not fire stops
 * firing (`stopped`): it is unprovisioned, and when the platform carries that
 * line's checker it is validated under its own pin and the verdict recorded.
 * It never reads as firing; the detail says what its version still provides
 * (Run now and test runs, when it runs). Any other pin is `refused` with the
 * rule's text (an older line moves by an explicit upgrade).
 */
async function checkReleasePin(input: {
  deps: DeployCheckDeps;
  movement: MovementRow;
  current: LanguageVersion;
  at: string;
}): Promise<DeployCheckEntry> {
  const { deps, movement, current, at } = input;
  const releaseLanguage = deps.release.language;
  const pin = movement.languageVersion;

  const listening = listeningOf(pin);
  switch (listening.kind) {
    case 'current':
      break;
    case 'held':
      return releasePinNotListened(input);
    default:
      return neverAsAny(listening);
  }

  const underPin = await deps.validate(validationUnder(movement, pin));
  await deps.recordValidity({ movement, validation: underPin, checkedAgainst: pin });
  const pinErrors = errorsOf(underPin.diagnostics);
  if (pinErrors.length > 0) {
    const detail = diagnosticsText(pinErrors);
    logger.warn('[DeployCheck] an automation on the installed language does not validate', {
      movementId: movement.id,
      teamId: movement.teamId,
      languageVersion: pin,
      diagnostics: pinErrors,
    });
    await emitSafely(deps, () => ({
      teamId: movement.teamId,
      kind: VALIDATION_ISSUE,
      payload: payloadFor(movement, current, at, {
        reason: `Does not validate under language ${pin} after release ${deps.release.tag}: ${detail}`,
      }),
    }));
    return entryFor(movement, 'refused', pin, releaseLanguage, detail);
  }
  if (underPin.gaps.length > 0) {
    return entryFor(movement, 'unverified', pin, releaseLanguage, gapsText(underPin.gaps));
  }
  return entryFor(movement, 'current', pin, releaseLanguage, '');
}

/** A release pin whose listens this platform does not fire: an earlier line
 *  stops firing, and is then checked under its own pin when its checker is
 *  carried; a newer line, or a text that is no release, is refused. */
async function releasePinNotListened(input: {
  deps: DeployCheckDeps;
  movement: MovementRow;
  current: LanguageVersion;
  at: string;
}): Promise<DeployCheckEntry> {
  const { deps, movement, current, at } = input;
  const releaseLanguage = deps.release.language;
  const pin = movement.languageVersion;

  if (releaseVersionStanding(pin, current) === 'olderKey') {
    logger.warn('[DeployCheck] an automation written for an earlier release stops firing until it is upgraded', {
      movementId: movement.id,
      teamId: movement.teamId,
      languageVersion: pin,
      current,
    });
    // The stop is the safety and the check only information, so the stop
    // comes first: a check that fails cannot leave the automation firing.
    await deps.unprovision(movement);
    const checked = await checkedUnderOwnPin(deps, movement);
    // A carried version says what it still provides (it may run when someone
    // starts it); a key this build does not carry, the language's own text.
    const why =
      (versionOf(pin) !== undefined ? refusalOf(pin, 'listen') : undefined) ??
      releaseVersionDiagnostic(pin, current)?.message ??
      `this automation pins language ${pin}, which the installed language ${current} does not read`;
    const detail = `${why}; ${checked}its listens do not fire until it is upgraded`;
    await emitSafely(deps, () => ({
      teamId: movement.teamId,
      kind: VALIDATION_ISSUE,
      payload: payloadFor(movement, current, at, { reason: `After release ${deps.release.tag}: ${detail}` }),
    }));
    return entryFor(movement, 'stopped', pin, releaseLanguage, detail);
  }

  const detail =
    releaseVersionDiagnostic(pin, current)?.message ??
    `this automation pins language ${pin}, which the installed language ${current} does not read`;
  logger.warn('[DeployCheck] an automation pins a language the installed one does not read', {
    movementId: movement.id,
    teamId: movement.teamId,
    languageVersion: pin,
    current,
  });
  await emitSafely(deps, () => ({
    teamId: movement.teamId,
    kind: VALIDATION_ISSUE,
    payload: payloadFor(movement, current, at, { reason: `After release ${deps.release.tag}: ${detail}` }),
  }));
  return entryFor(movement, 'refused', pin, releaseLanguage, detail);
}

/** The verdict of `movement`'s own version's checker, recorded as its
 *  validity, as the start of a clause: empty when its version's checker is
 *  not carried, so nothing is claimed of it. A check that fails says so in
 *  the clause and claims nothing either. */
async function checkedUnderOwnPin(deps: DeployCheckDeps, movement: MovementRow): Promise<string> {
  const pin = movement.languageVersion;
  const checking = checkingOf(pin);
  switch (checking.kind) {
    case 'held':
      return '';
    case 'current':
    case 'carried':
      try {
        const underPin = await deps.validate({ movement, languageVersion: pin });
        await deps.recordValidity({ movement, validation: underPin, checkedAgainst: pin });
        const errors = errorsOf(underPin.diagnostics);
        if (errors.length > 0) return `checked under ${pin}, it does not validate (${diagnosticsText(errors)}); `;
        if (underPin.gaps.length > 0) return `checked under ${pin}, it validates, but ${gapsText(underPin.gaps)}; `;
        return `checked under ${pin}, it validates; `;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[DeployCheck] could not check a stopped automation under its own language version', {
          movementId: movement.id,
          teamId: movement.teamId,
          languageVersion: pin,
          error: message,
        });
        return `it could not be checked under ${pin} (${message}); `;
      }
    default:
      return neverAsAny(checking);
  }
}

/** How a version is named in an event's text. */
function describeVersion(version: LanguageVersion): string {
  return isLegacyLanguageVersion(version) ? `legacy ${version}` : version;
}

/** A movement left on a deprecated legacy id is told so, once per release. */
async function emitDeprecation(
  deps: DeployCheckDeps,
  movement: MovementRow,
  version: LanguageVersion,
  at: string,
): Promise<void> {
  if (!deps.release.language.deprecated.has(version)) return;
  await emitSafely(deps, () => ({
    teamId: movement.teamId,
    kind: DEPRECATED_VERSION,
    payload: payloadFor(movement, version, at, {
      reason: `${describeVersion(version)} is deprecated: upgrade it to ${deps.release.language.current} before a release stops running it.`,
    }),
  }));
}

/** An event that cannot be built or recorded is logged, never allowed to
 *  stop the sweep: the stored diagnostics are the fact, the event only its
 *  notice. */
async function emitSafely(
  deps: DeployCheckDeps,
  build: () => { teamId: string; kind: SystemEventKind; payload: SystemEventPayload },
): Promise<void> {
  try {
    await deps.emit(build());
  } catch (err) {
    logger.error('[DeployCheck] could not record a system event', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** One program's notice. `version` is the release involved: for a
 *  `Validation Issue` the running release it fails to validate under, for a
 *  `Deprecated Version` the deprecated version it is pinned to
 *  (docs/contracts/system-events.md in listen-fire). */
function payloadFor(
  movement: MovementRow,
  version: LanguageVersion,
  at: string,
  input: { reason: string },
): SystemEventPayload {
  return {
    automation: movement.name,
    automationId: movement.id,
    runId: '',
    version,
    reason: input.reason,
    url: automationUrl(movement.id),
    at,
  };
}

function entryFor(
  movement: MovementRow,
  outcome: DeployCheckOutcome,
  to: LanguageVersion,
  release: PlatformLanguageRelease,
  detail: string,
): DeployCheckEntry {
  return {
    id: movement.id,
    teamId: movement.teamId,
    name: movement.name,
    outcome,
    from: versionView(movement.languageVersion),
    to: versionView(to),
    deprecated: release.deprecated.has(movement.languageVersion),
    detail,
  };
}

function gapsText(gaps: TeamMovementValidation['gaps']): string {
  return `could not read ${gaps.length} connected system(s) to check against`;
}

function countOutcomes(entries: DeployCheckEntry[]): Record<DeployCheckOutcome, number> {
  const counts: Record<DeployCheckOutcome, number> = {
    upgradable: 0,
    current: 0,
    warned: 0,
    stopped: 0,
    refused: 0,
    unverified: 0,
  };
  for (const entry of entries) counts[entry.outcome] += 1;
  return counts;
}

function releaseAppliedReason(
  tag: string,
  current: LanguageVersion,
  counts: Record<DeployCheckOutcome, number>,
  stopped: readonly string[],
): string {
  const stoppedLine =
    stopped.length > 0
      ? ` Stopped firing until you upgrade them, written for an earlier release: ${stopped.join(', ')}.`
      : '';
  return (
    `Release ${tag} applied. Clean under ${describeVersion(current)}, upgraded when you ask: ${counts.upgradable}. ` +
    `Already on it: ${counts.current}. Not clean under it: ${counts.warned}. ` +
    `Not validating or not read: ${counts.refused}. Could not be checked: ${counts.unverified}.` +
    stoppedLine
  );
}

// ── The real dependencies ───────────────────────────────────────────────────

/** Validate against the team's live catalog, inside the team. `teamFacts`
 *  is how a carried pin's check reads the team; absent reads it each time. */
export function liveValidation(teamFacts?: (teamId: string) => Promise<TeamFacts>): ValidateUnder {
  return ({ movement, languageVersion, upgradingFrom, source, movingWith }) =>
    withTeamContext(movement.teamId as TeamId, () =>
      validateMovementForTeam({
        teamId: movement.teamId,
        source: source ?? movement.source,
        languageVersion,
        // Reaches imported library files too: the checker checks them under the
        // importer's version and move, and surfaces their warnings.
        ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
        ...(movingWith !== undefined ? { movingWith } : {}),
        ...(teamFacts !== undefined ? { teamFacts } : {}),
      }),
    );
}

export const validateUnderLiveCatalog: ValidateUnder = liveValidation();

export function liveDeployCheckDeps(release: DeployCheckRelease): DeployCheckDeps {
  return {
    release,
    alreadyRan: async ({ tag, languageRelease }) => {
      const row = await getAutomationsQb(['deploy_check'])
        .selectFrom('deploy_check')
        .where('release_tag', '=', tag)
        .where('language_release', '=', languageRelease)
        .select('id')
        .executeTakeFirst();
      return row !== undefined;
    },
    listMovements: listAllMovementRows,
    // One read of each team's facts for the whole sweep, however many of its
    // automations a carried version checks.
    validate: liveValidation(teamFactsOncePerTeam()),
    sourceHash: movementSourceHash,
    recordValidity: async ({ movement, validation, checkedAgainst }) => {
      const assessment = assessMovementValidity({
        diagnostics: validation.diagnostics,
        gaps: validation.gaps,
      });
      await recordValidityOutcome({
        id: movement.id,
        status: assessment.status,
        reason: assessment.reason,
        sourceHash: movementSourceHash(movement.source),
        checkedAgainst,
      });
    },
    recordUpgradeCheck: ({ movement, diagnostics, checkedAgainst }) =>
      recordUpgradeCheck({ id: movement.id, diagnostics, checkedAgainst }),
    emit: recordSystemEvent,
    unprovision: async (movement) => {
      const triggers = await getAutomationsQb(['trigger'])
        .selectFrom('trigger')
        .where('movement_id', '=', movement.id as MovementId)
        .where('team_id', '=', movement.teamId as TeamId)
        .select('id')
        .execute();
      if (triggers.length === 0) return;
      await settleRunsParkedOnTriggers({
        triggerIds: triggers.map((t) => t.id),
        reason: 'This run was waiting under an earlier release; its automation stopped at the upgrade. Upgrade the automation, then run it again.',
      });
      await getAutomationsQb(['trigger'])
        .deleteFrom('trigger')
        .where('id', 'in', triggers.map((t) => t.id))
        .execute();
    },
    recordRun: async ({ tag, languageRelease, summary }) => {
      await getAutomationsQb(['deploy_check'])
        .insertInto('deploy_check')
        .values({ release_tag: tag, language_release: languageRelease, summary })
        .onConflict((oc) => oc.columns(['release_tag', 'language_release']).doNothing())
        .execute();
    },
    now: () => new Date(),
  };
}

/**
 * Move a pin for real, for an explicit upgrade: always a save, whether or not
 * the rewrite changed the text. The text and the pin it is written in move
 * together, the automation's listens are provisioned under the new pin and its
 * snapshot minted, so no run ever sees the new spelling under the old pin or
 * the old under the new, and a version whose listens did not fire ends up with
 * its listens firing.
 *
 * The catalog is assembled here, before the group's transaction opens: it is
 * the one provider read the save needs up front. Its imports of the members
 * moving before it resolve to their moved text, which is not in the database
 * yet.
 */
export const advanceLive: Advance = async ({ movement, to, source, movingWith }) => {
  const teamCatalog = await withTeamContext(movement.teamId as TeamId, () =>
    movementCatalogForTeam(movement.teamId as TeamId, {
      source,
      languageVersion: to,
      ...(movingWith.size > 0 ? { movingWith } : {}),
    }),
  );
  return async () => {
    const saved = await saveMovement({
      teamId: movement.teamId,
      id: movement.id,
      source,
      languageUpgrade: { to },
      inTransaction: { teamCatalog },
    });
    if (saved.ok) return { ok: true };
    return { ok: false, detail: `the rewritten text did not ship: ${(saved.errors ?? []).join('; ') || 'the save stopped short of shipping'}` };
  };
};

/** The most recent check's summary — what `deploy/up.sh` prints. */
export async function latestDeployCheckSummary(): Promise<DeployCheckSummary | null> {
  const row = await getAutomationsQb(['deploy_check'])
    .selectFrom('deploy_check')
    .select('summary')
    .orderBy('ran_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? (row.summary as DeployCheckSummary) : null;
}

// ── The explicit upgrade ────────────────────────────────────────────────────

/** Another member of an upgrade's import group. */
export interface GroupMember {
  automation: { id: string; name: string };
  /** Its text rewritten into the target version's spelling, when the
   *  rewrite changed it. */
  upgradedSource?: string;
}

/** A member of an upgrade's import group that cannot move, so the whole group
 *  stays where it is. */
export interface HeldMember extends GroupMember {
  /** What holds it: its blocking diagnostics under the target version (their
   *  places are in its `upgradedSource` when it is present), or none when a
   *  connected system it uses could not be read. */
  diagnostics: AuthoringDiagnostic[];
  unverified: boolean;
}

export type UpgradeMovementResult =
  | { status: 'not_found' }
  | {
      status: 'already_current' | 'upgraded' | 'needs_acknowledgement' | 'blocked' | 'unverified';
      automation: { id: string; name: string };
      from: VersionView;
      to: VersionView;
      /** The blocking diagnostics under the target version — empty when clean.
       *  Their places are in `upgradedSource` when it is present. */
      diagnostics: AuthoringDiagnostic[];
      /** The text rewritten into the target version's spelling, when the
       *  rewrite changed it: saved with the pin on `upgraded`, shown otherwise. */
      upgradedSource?: string;
      /** The automations and libraries on its version connected to it by
       *  imports. An import is allowed only between files on one version, so
       *  they move with it, or none of them moves. Absent when there are none. */
      movesWith?: GroupMember[];
      /** The other members of the group that cannot move, each with what
       *  holds it: nothing in the group moves until they can. */
      heldBy?: HeldMember[];
      /** Why a clean, acknowledged move still did not land. */
      detail?: string;
    };

/** One member of the group, checked for the move. */
interface CheckedMember {
  movement: MovementRow;
  rewrite: UpgradeRewrite;
  diagnostics: AuthoringDiagnostic[];
  held: boolean;
  unverified: boolean;
}

/**
 * Validate one movement under the installed language and report what that
 * finds. The pin moves only when the result is clean AND the caller
 * acknowledged it — so the first call shows the diagnostics, and a second,
 * acknowledged one acts.
 *
 * A pin the installed language reads is already current. A legacy id, or a
 * release pin of an older line, has its old spellings rewritten
 * (`rewriteForUpgrade`), checked as a move up from its pin. A newer release's
 * pin has nothing to move to: blocked, with the rule's text.
 *
 * An import is allowed only between files on the same version, so the movement
 * moves with its import group (`importGroupOf`): every automation and library
 * on its version connected to it by imports. Each member is rewritten and
 * checked, libraries first, each against the members it imports as they will
 * be once moved. The group moves only when every member is clean; otherwise
 * nothing moves and the members that cannot are named. Moving one alone would
 * break its imports with the rest and stop an importer.
 */
export async function upgradeMovement(input: {
  teamId: string;
  id: string;
  acknowledge: boolean;
  /** Apply every fix offered, also those not proved to keep the meaning
   *  (listed on the diagnostics otherwise), and move past the warnings that
   *  the program may now do something else, once the author checked them. */
  applyAllFixes?: boolean;
  validate?: ValidateUnder;
  advance?: Advance;
  /** How the group's moves are made together; absent, one transaction. */
  together?: MoveTogether;
}): Promise<UpgradeMovementResult> {
  const movement = await getMovementRow({ teamId: input.teamId, id: input.id });
  if (!movement) return { status: 'not_found' };
  const to = LANGUAGE_VERSION;
  const pin = movement.languageVersion;
  const base = {
    automation: { id: movement.id, name: movement.name },
    from: versionView(pin),
    to: versionView(to),
  };
  if (isCurrent(pin)) {
    return { status: 'already_current', ...base, diagnostics: [] };
  }
  const validate = input.validate ?? validateUnderLiveCatalog;
  if (!isLegacyLanguageVersion(pin) && !movesUp(pin, to)) {
    const refusal = releaseVersionDiagnostic(pin, to);
    const lines = movement.source.split('\n');
    return {
      status: 'blocked',
      ...base,
      diagnostics: refusal === undefined ? [] : [toAuthoringDiagnostic(refusal, lines)],
    };
  }

  const all = input.applyAllFixes === true;
  const group = importGroupOf(movement, await listMovementRows(input.teamId));
  const movingWith = new Map<string, ImportedFile>();
  const checked: CheckedMember[] = [];
  for (const member of group) {
    const rewrite = await rewriteForUpgrade({ movement: member, to, validate, all, movingWith: new Map(movingWith) });
    movingWith.set(member.name, { source: rewrite.source, languageVersion: to });
    const diagnostics = blockingDiagnostics(rewrite.validation.diagnostics);
    await recordUpgradeCheck({ id: member.id, diagnostics, checkedAgainst: to });
    const held = holdsThePin(diagnostics, all).length > 0;
    checked.push({ movement: member, rewrite, diagnostics, held, unverified: !held && rewrite.validation.gaps.length > 0 });
  }

  const own = checked.find((member) => member.movement.id === movement.id);
  if (own === undefined) throw new Error('the import group of an upgrade lost the movement it was asked for');
  const others = checked.filter((member) => member !== own);
  const asMember = (member: CheckedMember): GroupMember => ({
    automation: { id: member.movement.id, name: member.movement.name },
    ...(member.rewrite.changed ? { upgradedSource: member.rewrite.source } : {}),
  });
  const heldBy: HeldMember[] = others
    .filter((member) => member.held || member.unverified)
    .map((member) => ({ ...asMember(member), diagnostics: member.diagnostics, unverified: member.unverified }));
  const diagnostics = own.diagnostics;
  const shown = {
    ...base,
    ...(own.rewrite.changed ? { upgradedSource: own.rewrite.source } : {}),
    ...(others.length > 0 ? { movesWith: others.map(asMember) } : {}),
    ...(heldBy.length > 0 ? { heldBy } : {}),
  };
  if (checked.some((member) => member.held)) {
    return { status: 'blocked', ...shown, diagnostics, ...(own.held ? {} : { detail: heldDetail(heldBy) }) };
  }
  if (checked.some((member) => member.unverified)) {
    return { status: 'unverified', ...shown, diagnostics, ...(own.unverified ? {} : { detail: heldDetail(heldBy) }) };
  }
  if (!input.acknowledge) return { status: 'needs_acknowledgement', ...shown, diagnostics };

  // Every member moves in one transaction, libraries first so each importer
  // is saved against what it imports as moved: a member that cannot move
  // undoes the members before it, so no importer is left on one version
  // importing a library moved to another. The transaction holds only database
  // writes: each member is prepared before it opens (the provider reads), and
  // what is owed the providers is a work row written inside it.
  const advance = input.advance ?? advanceLive;
  const together = input.together ?? inOneTransaction;
  const moves: { member: CheckedMember; move: MoveMember }[] = [];
  const moved = new Map<string, ImportedFile>();
  for (const member of checked) {
    const move = await advance({ movement: member.movement, to, source: member.rewrite.source, movingWith: new Map(moved) });
    moves.push({ member, move });
    moved.set(member.movement.name, { source: member.rewrite.source, languageVersion: to });
  }
  try {
    await together(movement.teamId, async () => {
      for (const { member, move } of moves) {
        const advanced = await move();
        if (!advanced.ok) throw new GroupMoveStopped(member.movement.name, advanced.detail);
        const assessment = assessMovementValidity({ diagnostics: member.rewrite.validation.diagnostics, gaps: [] });
        await recordValidityOutcome({
          id: member.movement.id,
          status: assessment.status,
          reason: assessment.reason,
          sourceHash: movementSourceHash(member.rewrite.source),
          checkedAgainst: to,
        });
      }
      await bringUpListensLater({ teamId: movement.teamId, movementIds: checked.map((member) => member.movement.id), key: movement.id });
    });
  } catch (err) {
    if (!(err instanceof GroupMoveStopped)) throw err;
    const who = others.length > 0 ? `${err.member}: ` : '';
    const nothing = others.length > 0 ? '; nothing moved' : '';
    return { status: 'unverified', ...shown, diagnostics, detail: `${who}${err.detail}${nothing}` };
  }
  return { status: 'upgraded', ...shown, diagnostics };
}

/** A member of an upgrading group that could not move: the group's
 *  transaction rolls back. */
class GroupMoveStopped extends Error {
  constructor(
    readonly member: string,
    readonly detail: string,
  ) {
    super(`${member}: ${detail}`);
  }
}

/** Runs `moves` as the team, in one database transaction: every write a save
 *  makes joins it, and a throw rolls all of them back. */
export type MoveTogether = (teamId: string, moves: () => Promise<void>) => Promise<void>;

export const inOneTransaction: MoveTogether = async (teamId, moves) => {
  await withTeamContext(teamId as TeamId, async () => {
    await currentContext().enterTransaction();
    await moves();
  });
};

/** Why a group stays: the members that cannot move, each with its reason. */
function heldDetail(heldBy: readonly HeldMember[]): string {
  const reasons = heldBy.map((member) =>
    member.unverified
      ? `${member.automation.name} (a connected system it uses could not be read)`
      : `${member.automation.name} (${diagnosticsText(member.diagnostics)})`,
  );
  return `it moves together with the automations and libraries it shares imports with, and these cannot move yet: ${reasons.join('; ')}`;
}

/** The standing release, for the entry points: the installed language, and
 *  the legacy ids the platform still runs. */
export function thisDeployCheckRelease(tag: string): DeployCheckRelease {
  return {
    tag,
    language: {
      current: LANGUAGE_VERSION,
      legacy: PLATFORM_SUPPORTED_LANGUAGE_VERSIONS,
      deprecated: PLATFORM_DEPRECATED_LANGUAGE_VERSIONS,
    },
  };
}
