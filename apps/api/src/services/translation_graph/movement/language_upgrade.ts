// A movement's language version pin moves ONLY by an explicit upgrade a person
// asks for (`upgradeMovement`): validation under the current version, shown to
// the caller first; the pin moves only when the caller acknowledges a clean
// result. Nothing moves a pin automatically (Henry, 2026-10-20).
//
// A pin is a legacy id ('1'..'4': the platform's TypeScript copy of the
// language reads it) or the semver of the language release it was written
// against, which the installed language reads when its rule says the two are
// compatible (movement-lang `compatible`). A current pin is judged by the
// wasm checker alone, against the run snapshot; legacy-lang judges only the
// legacy ids (./language_route.ts).
//
// THE DEPLOY CHECK, once per release over every team's movements
// (`runDeployCheck`), only reports. A release pin the installed language reads
// is `current`; one it does not read (an older line, or a newer release) is
// `refused` with the rule's text, and `upgradeMovement` is how an older one
// moves. A legacy id is validated under its own pin, which must pass (the
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
// under the current version (movement-lang checker/upgrade.ts — the loop
// `listen-fire upgrade` runs too): the fixes marked safe (they provably keep the
// meaning), and every fix when asked. What is judged is the rewritten text,
// and when the pin moves, the rewritten text is saved with it, in one save
// under the new pin. A movement that is not clean after the rewrite keeps its
// text and its pin; what is left is reported against the rewritten text
// (`upgradedSource`), each with its source line.
//
// An edit or re-save never moves the pin (store.ts).
//
// See plans/language-versioning-2026-09-29/1_design.md, "Deploy check".

import {
  LANGUAGE_VERSION,
  compatible,
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

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import {
  automationUrl,
  automationsUrl,
  recordSystemEvent,
} from '../adapters/system/events';
import {
  DEPRECATED_VERSION,
  RELEASE_APPLIED,
  VALIDATION_ISSUE,
  type SystemEventKind,
  type SystemEventPayload,
} from '@listen-fire/system';
import {
  assessMovementValidity,
  toAuthoringDiagnostic,
  validateMovementForTeam,
  type AuthoringDiagnostic,
  type TeamMovementValidation,
} from './authoring';
import { withTeamContext } from './firing_context';
import { saveMovement } from './provision';
import {
  advanceMovementLanguageVersion,
  getMovementRow,
  listAllMovementRows,
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

/** What `upgradeMovement` refuses outright. A move-up warning is not here: the
 *  deploy check reports it as standing in the way, but it fires on every use of a construct whose meaning changed
 *  whether or not the author edits, so the explicit upgrade lets the author
 *  acknowledge it, or the pin could never move. */
function hardErrors(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error');
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
}) => Promise<Pick<TeamMovementValidation, 'diagnostics' | 'gaps'>>;

/** What moving a pin did. Moving it with a rewritten text is a save, which
 *  can still land short of shipping. */
export type AdvanceOutcome = { ok: true } | { ok: false; detail: string };

/** Move `movement`'s pin to `to` — with `source`, saving that text with it.
 *  Only an explicit upgrade calls it. */
export type Advance = (input: { movement: MovementRow; to: LanguageVersion; source?: string }) => Promise<AdvanceOutcome>;

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
}): Promise<UpgradeRewrite> {
  const validations = new Map<string, Pick<TeamMovementValidation, 'diagnostics' | 'gaps'>>();
  const result = await upgradeSourceAsync(input.movement.source, async (source) => {
    const validation = await input.validate({
      ...validationUnder(input.movement, input.to),
      ...(source !== input.movement.source ? { source } : {}),
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
  /** A release pin the installed language does not read (an older line, or a
   *  newer release), or a legacy id that does not validate under its own pin
   *  (the release failed to preserve that version's behaviour). The pin stays. */
  | 'refused'
  /** Could not be checked (a connected system could not be read, or the check
   *  itself failed): the pin stays and nothing is claimed. */
  | 'unverified';

export const DEPLOY_CHECK_OUTCOMES: readonly DeployCheckOutcome[] = [
  'upgradable',
  'current',
  'warned',
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
    const counts = countOutcomes(entries.filter((e) => e.teamId === teamId));
    await emitSafely(deps, () => ({
      teamId,
      kind: RELEASE_APPLIED,
      payload: {
        automation: '',
        automationId: '',
        runId: '',
        version: summary.current.name,
        reason: releaseAppliedReason(release.tag, current, counts),
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
      payload: payloadFor(movement, pin, at, {
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
      payload: payloadFor(movement, pin, at, {
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

/** A release pin: what the installed language's rule says of it. The
 *  installed language reads it — validated under it, `current` when clean of
 *  errors — or it does not, and it is `refused` with the rule's text (an older
 *  line moves by an explicit upgrade). */
async function checkReleasePin(input: {
  deps: DeployCheckDeps;
  movement: MovementRow;
  current: LanguageVersion;
  at: string;
}): Promise<DeployCheckEntry> {
  const { deps, movement, current, at } = input;
  const releaseLanguage = deps.release.language;
  const pin = movement.languageVersion;

  if (!compatible(pin, current)) {
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
      payload: payloadFor(movement, pin, at, { reason: `After release ${deps.release.tag}: ${detail}` }),
    }));
    return entryFor(movement, 'refused', pin, releaseLanguage, detail);
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
      payload: payloadFor(movement, pin, at, {
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
): string {
  return (
    `Release ${tag} applied. Clean under ${describeVersion(current)}, upgraded when you ask: ${counts.upgradable}. ` +
    `Already on it: ${counts.current}. Not clean under it: ${counts.warned}. ` +
    `Not validating or not read: ${counts.refused}. Could not be checked: ${counts.unverified}.`
  );
}

// ── The real dependencies ───────────────────────────────────────────────────

/** Validate against the team's live catalog, inside the team. */
export const validateUnderLiveCatalog: ValidateUnder = ({ movement, languageVersion, upgradingFrom, source }) =>
  withTeamContext(movement.teamId as TeamId, () =>
    validateMovementForTeam({
      teamId: movement.teamId,
      source: source ?? movement.source,
      languageVersion,
      // Reaches imported library files too: the checker checks them under the
      // importer's version and move, and surfaces their warnings.
      ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
    }),
  );

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
    validate: validateUnderLiveCatalog,
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
 * Move a pin for real, for an explicit upgrade. Without a rewrite, the pin
 * moves on its own (and the current snapshot is re-minted under it). With one,
 * the rewritten text is saved under the new pin in one save — the text and the pin it is written in
 * move together, its listeners are reconciled and its snapshot minted — so no
 * run ever sees the new spelling under the old pin or the old under the new.
 */
export const advanceLive: Advance = async ({ movement, to, source }) => {
  if (source === undefined) {
    await advanceMovementLanguageVersion({ teamId: movement.teamId, id: movement.id, to });
    return { ok: true };
  }
  const saved = await withTeamContext(movement.teamId as TeamId, () =>
    saveMovement({ teamId: movement.teamId, id: movement.id, source, languageUpgrade: { to } }),
  );
  if (saved.ok) return { ok: true };
  return { ok: false, detail: `the rewritten text did not ship: ${(saved.errors ?? []).join('; ') || 'the save stopped short of shipping'}` };
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
      /** Why a clean, acknowledged move still did not land. */
      detail?: string;
    };

/**
 * Validate one movement under the installed language and report what that
 * finds. The pin moves only when the result is clean AND the caller
 * acknowledged it — so the first call shows the diagnostics, and a second,
 * acknowledged one acts.
 *
 * A pin the installed language reads is already current. A legacy id has its
 * old spellings rewritten (`rewriteForUpgrade`). A release pin of an older
 * line is validated as written, as a move up from its pin. A newer release's
 * pin has nothing to move to: blocked, with the rule's text.
 */
export async function upgradeMovement(input: {
  teamId: string;
  id: string;
  acknowledge: boolean;
  /** Apply every fix offered, also those not proved to keep the meaning
   *  (listed on the diagnostics otherwise). */
  applyAllFixes?: boolean;
  validate?: ValidateUnder;
  advance?: Advance;
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
  if (!isLegacyLanguageVersion(pin) && compatible(pin, to)) {
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

  const rewrite: UpgradeRewrite = isLegacyLanguageVersion(pin)
    ? await rewriteForUpgrade({ movement, to, validate, all: input.applyAllFixes === true })
    : { source: movement.source, changed: false, validation: await validate(validationUnder(movement, to)) };
  const { validation } = rewrite;
  const diagnostics = blockingDiagnostics(validation.diagnostics);
  const shown = { ...base, ...(rewrite.changed ? { upgradedSource: rewrite.source } : {}) };
  await recordUpgradeCheck({ id: movement.id, diagnostics, checkedAgainst: to });
  if (hardErrors(diagnostics).length > 0) return { status: 'blocked', ...shown, diagnostics };
  if (validation.gaps.length > 0) return { status: 'unverified', ...shown, diagnostics };
  if (!input.acknowledge) return { status: 'needs_acknowledgement', ...shown, diagnostics };

  const advanced = await (input.advance ?? advanceLive)({
    movement,
    to,
    ...(rewrite.changed ? { source: rewrite.source } : {}),
  });
  if (!advanced.ok) return { status: 'unverified', ...shown, diagnostics, detail: advanced.detail };
  const assessment = assessMovementValidity({ diagnostics: validation.diagnostics, gaps: [] });
  await recordValidityOutcome({
    id: movement.id,
    status: assessment.status,
    reason: assessment.reason,
    sourceHash: movementSourceHash(rewrite.source),
    checkedAgainst: to,
  });
  return { status: 'upgraded', ...shown, diagnostics };
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
