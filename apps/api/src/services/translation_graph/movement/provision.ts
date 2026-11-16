// Text-canonical movement persistence + listener reconciliation.
//
// `saveMovement` is the public entry point: it writes the canonical
// `automations.movement` row FIRST (the program text survives any failed
// gate), then provisions the file's DERIVED trigger rows and records the
// legacy first-listener link on the row.
//
// Trigger semantics live in the .mvt text ("the file declares its
// listeners", plans/2026-06-10-data-movement-language/6_engine.md):
//
//   listen to inbox { key: "dealflow" } fire dealflow_intake
//
// One `automations.trigger` row per `listen` statement, fully derived and
// not otherwise editable — kind/credentials come from the listened
// instance's construction, `config` from the listen's config block, the
// name from the stable `movement/<file>/<movement>` convention, and the
// row is linked to its movement via `trigger.movement_id`. The single
// hand-editable field is `run_mode` (operational pause state): it
// defaults to 'live' on creation and reconciliation NEVER touches it
// afterwards. A file with zero listens is a library — saving it retires
// any previously derived triggers.
//
// EXECUTION reads the SHIPPED text (the version a shipped save mints, not
// the row's live source): a movement-derived trigger always
// dispatches through `runMovement` (the movement engine,
// services/movement_engine/run.ts) — see ./execute.ts and
// triggers/router.ts. The trigger row is purely the dispatch index; it
// carries NO orchestration / object code (reconciliation clears any),
// and the authored-liveness gate derives a movement trigger's liveness
// from the movement row (storage/authored.ts).
//
// The save gate is the runtime-validity consent gate (decision 3b,
// plans/2026-07-13-movement-validity-lifecycle): a non-`valid` save
// without consent returns `needsConfirmation` (text saved, nothing
// shipped); a `valid` or consented save SHIPS — listeners reconciled,
// version minted — and is what runs from then on.
//
// Consent covers the CONSEQUENCE, including the worst one. A consented
// save whose source cannot be PARSED yields no listener set at all, so
// there is nothing to reconcile against: every listener the movement had
// is retired (runs parked on them settled, not stranded) and the save
// comes back with a warning saying the automation no longer fires until a
// parseable source restores them. The alternative — leaving the old rows
// firing text that no longer exists — is what shipped before, and it made
// the saved file and the running behaviour silently disagree.
//
// Reconciliation preserves row identity: an unchanged listen keeps its
// trigger id (and therefore its trigger_run history — `trigger_run` rows
// carry `trigger_id` without an FK, so retiring a listener orphans its
// history rather than deleting it).
//
// "Run now" is a LISTENER too: a manual-channel listen (`listen to
// manual() {} fire backfill`) derives an ordinary trigger row, and
// `runMovementNow` (./run_now.ts) injects an invocation event on it
// through normal dispatch — uniform run_mode gating, uniform trigger_run
// recording. `listen` is the only invoker; the former `run` entry is
// retired.

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { LANGUAGE_VERSION, parseProgram as parseInstalled, scanName } from 'movement-lang';
import { MovementParseError } from 'movement-lang';

import type {
  Diagnostic,
  LanguageVersion,
  MovementDeclaration,
  Program,
} from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerRunMode } from '../triggers/run_mode';

import { mq } from '../../../lib/message_queue';
import { unsafeCurrentContext } from '../../../services/context';
import { logger } from 'movement-engine/public/log';
import { recordUserMilestone, recordTeamMilestone } from '../../../lib/journey';
import { getAutomationsQb } from '../../../lib/kysely';
import { inboxAddressesOf } from '../adapters/email/listen_keys';
import { enqueueWork } from '../../work/store';
import type { WorkKind } from '../../work/kinds';
import { syncListenSubscriptions } from './listen_subscriptions';
import { pollSubscriptionId } from '../../poll_source/worker';
import { movementWriteRunMode } from './dry_run';
import { loopBreakerPauses, pauseListenConfig, pipelineOfConfig } from '../../inbound/listen_pause';
import {
  manualListenerMovements,
  movementFileFacets,
  type MovementFileFacets,
} from './files';
import { movementCatalogForTeam, type CatalogGap, type TeamMovementCatalog } from './catalog';
import type { CatalogAudience } from './audience';
import { checkCreation, checkedList, recomputeLibraryStanding, setStatement, stateCreation, StatementRefusedError, type CreationStatements } from '../../access/decide';
import {
  READ_ONLY_REFUSAL,
  STATEMENTS_ON_OVERWRITE_REFUSAL,
  accessWarnings,
  connectionsNamed,
  connectionsRefusal,
  creationStatements,
  exportsSomething,
  FIRST_EXPORT_REFUSAL,
  hideUnreadableLibraries,
  inOneTransaction,
  librariesNamed,
  librariesRefusal,
  missingStatementRefusal,
  nameGoneRefusal,
  nameTakenRefusal,
  overwriteRefusal,
  saverOf,
  stateRunCreation,
  unusableConnections,
  unusableLibraries,
  type SaveRefusal,
} from './save_access';
import { StatementStore } from '../../access/statement';
import {
  deleteMovementRow,
  getMovementRow,
  getMovementRowByName,
  leftoverTriggerConfig,
  listDerivedTriggerRows,
  listLeftoverTriggerRows,
  triggersUnfinishedRunsName,
  listDerivedTriggerRowsForMovements,
  listMovementRows,
  listenersFiringMovementNames,
  pendingUpgradeDiagnostics,
  recordDerivedTriggerLink,
  recordValidityOutcome,
  writeMovementRow,
  MovementGoneError,
  MovementNameTakenError,
  type DerivedTriggerRow,
  type MovementWriteIntent,
  type MovementRow,
  type MovementValidityStatus,
} from './store';
import { mintMovementVersionIfChanged, movementSourceHash } from './version_store';
import { stepTimer, type StepTimer } from './timing';
import { settleRunsParkedOnTriggers } from '../../interaction/run_failure';
import {
  assessMovementValidity,
  diagnoseMovementSource,
  type AuthoringDiagnostic,
  type MovementValidation,
  type MovementValidityAssessment,
} from './authoring';
import { checkInstalled, routeOf } from './language_route';
import { notListenedDiagnostic, teamFactsOf, validateUnderCarried } from './carried_check';
import { carriedListen, carryingFromShipped, heardAnything, heardSoFarOf, keepCarriedCursors, keepingCarriedFrom, predecessorsOf, type CarriedListen, type CarryingFrom, type HeardRow } from './carried_cursors';
import { modulePlatform } from './carried_run';
import { listeningOf, type ListeningLane } from '@listen-fire/language-versions';
import { runningOf } from '@listen-fire/language-versions';
import { plannedListensOfSource } from './listen_plans';
import { carriedPauses, listenIdentityOf, type CarriedPause } from './carried_pauses';
import { carriedRunTriggerId } from './carried_names';
import { revokeCallbacksForRuns } from '../../movement_engine/callback_store';
import { listenConfigSchema, type ListenConfig, type SavedListen } from '../../inbound/listen_door';
import { resolveAndArm, resolvesListen } from '../../inbound/listen_resolve';
import { listenPauses, type ListenPause } from '../../inbound/listen_pause';

/** Resource-change hint for a movement save/delete — fired from the
 *  shared service so UI and agent callers both propagate. The actor isn't
 *  reliably known here; 'user' is the default (the agent's saveMovement
 *  tool flows through this same service). Best-effort. */
function emitMovementChange(input: {
  teamId: string;
  movementId: string;
  action: string;
  /** Who authored this change. Agent saves run inside the user's request
   *  origin, so the open editor would dedup them by originId and miss the
   *  live fill-in — marking them 'agent' lets the page reflect them anyway. */
  source?: 'agent' | 'user';
}): void {
  const originId = unsafeCurrentContext()?.originId;
  mq.resourceChanges.changed
    .publish({
      kind: 'movement',
      teamId: input.teamId,
      source: input.source ?? 'user',
      action: input.action,
      resourceId: input.movementId,
      ...(originId ? { originId } : {}),
    })
    .catch(() => {});
}

// ── Provisioning result shapes ──────────────────────────────────────────────

export interface ProvisionedListener {
  triggerId: string;
  /** The movement this listener fires. */
  movementName: string;
  /** `automations.trigger.kind` — the source adapter slug (the channel). */
  kind: string;
  credentialsId: string | null;
  config: Record<string, unknown>;
  /** `config.key`, when the listen declares one. */
  configKey: string | null;
  /** `<local>+<key>@<domain>` for adapters with an inbound routing key, else null. */
  inboundAddress: string | null;
  /** The one hand-editable listener field (never touched by reconciliation). */
  runMode: TriggerRunMode;
  /** Whether an existing derived row was kept (identity + run history preserved). */
  reused: boolean;
}

export interface ProvisionedMovement {
  ok: true;
  /** The file's primary movement name (the row's name source). */
  movementName: string;
  /** One per `listen` statement, in file order. Empty = library file. */
  listeners: ProvisionedListener[];
  /** Info-severity diagnostics (e.g. MOV_LISTEN_MISSING) — never blocking. */
  infos: Diagnostic[];
  /** Catalog assembly notes (honest gaps — untyped adapters, collisions). */
  catalogNotes: string[];
  /** The save SUCCEEDED, but something about what now runs would surprise the
   *  author — listeners retired by a consented unparseable save, a movement
   *  name another automation already fires. Never blocking; always shown. */
  warnings: string[];
  /** A language upgrade's: the listens it left paused because it could not
   *  tell which of the earlier listens a person had paused. Not a warning of
   *  every save, so it is not among `warnings`. */
  leftPaused?: string[];
  /** A language upgrade's: the listens that had heard something and could not
   *  take how far with them, each starting from its first poll. As `leftPaused`,
   *  not a warning of every save. */
  cursorsNotCarried?: string[];
}

export interface ProvisionMovementFailure {
  ok: false;
  /** Parse/check diagnostics, when the check failed. */
  diagnostics?: Diagnostic[];
  /** Unsupported-construct or provisioning errors. */
  errors?: string[];
  catalogNotes: string[];
}

export type ProvisionMovementResult = ProvisionedMovement | ProvisionMovementFailure;

// ── Listener reconciliation ─────────────────────────────────────────────────

/** One planned listen as provisioning makes its trigger row. */
interface DesiredListener {
  movementName: string;
  /** The listen's module: the trigger row's kind. */
  adapter: string;
  /** `listen as "…"`: the trigger's name when present. */
  alias?: string;
  /** What the trigger row keeps (listen_door.ts `listenConfigSchema`; a
   *  carried version's listener keeps its own). */
  config: { listen: ListenConfig } | Record<string, unknown>;
  /** The text-derived dry_run⇄live axis (the universal `dry_run`
   *  construction parameter). */
  textRunMode: Extract<TriggerRunMode, 'live' | 'dry_run'>;
  credentialsId: string | null;
  /** A carried version's listen: its full address, names to ids. */
  resolvedAddress?: Record<string, string>;
}

/** The routing discriminator inside a (kind, credentials) channel:
 *  inbound-routing-key listens route by `key`; cron listens by their
 *  `schedule` (two schedules = two listeners);
 *  address-hop listens (Airtable) by their RESOLVED address (two tables =
 *  two listeners). The resolved spelling deliberately matches the legacy
 *  config-derived `base:table` string — key-sorted values, `:`-joined — so
 *  pre-resolution rows keep their identity (and their run history) across
 *  the transition. */
function configKeyOf(
  config: Record<string, unknown>,
  resolvedAddress?: Record<string, string>,
): string | null {
  // A planned listen is named by its pipeline: its plan and its connection's
  // construction, digested as listen-fire names it.
  const planned = listenConfigSchema.safeParse(config);
  if (planned.success) return planned.data.listen.pipeline;
  if (resolvedAddress !== undefined && Object.keys(resolvedAddress).length > 0) {
    return Object.entries(resolvedAddress)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value)
      .join(':');
  }
  if (typeof config['key'] === 'string') return config['key'] as string;
  if (typeof config['node_type_id'] === 'string') return config['node_type_id'] as string;
  if (typeof config['type'] === 'string') return config['type'] as string;
  if (typeof config['schedule'] === 'string') return config['schedule'] as string;
  if (typeof config['base'] === 'string' && typeof config['table'] === 'string') {
    return `${config['base']}:${config['table']}`;
  }
  return null;
}

/** Where a person sends mail for this listen, when it hears the shared inbox:
 *  what the listeners panel and the story's trigger sentence both say. */
export function inboundAddressOf(config: Record<string, unknown>): string | null {
  const planned = listenConfigSchema.safeParse(config);
  return planned.success ? inboxAddressesOf(planned.data.listen.plan, planned.data.listen.fieldIds) : null;
}

/** The discriminator in SURFACE spelling — what the listener summary
 *  reports, and what the editor's listeners panel matches the script's
 *  own `listen` statements against (the script knows `type: "company"`,
 *  never the resolved node-type UUID; `identityKeyOf` keeps using the
 *  UUID-preferring chain so trigger identity is unaffected). */
function surfaceConfigKeyOf(config: Record<string, unknown>): string | null {
  const planned = listenConfigSchema.safeParse(config);
  if (planned.success) return planned.data.listen.pipeline;
  if (typeof config['key'] === 'string') return config['key'] as string;
  if (typeof config['type'] === 'string') return config['type'] as string;
  if (typeof config['schedule'] === 'string') return config['schedule'] as string;
  if (typeof config['base'] === 'string' && typeof config['table'] === 'string') {
    return `${config['base']}:${config['table']}`;
  }
  return null;
}

/** Row identity: (movement, adapter kind, credentials, config key). A derived
 *  trigger belongs to the MOVEMENT it fires, never to a file position — so an
 *  unchanged listen keeps its trigger id and run history across saves EVEN when
 *  a new movement is inserted ahead of it or the movements are reordered. Two
 *  listens that fire different movements over the same channel+config are two
 *  identities (the old key conflated them, and the reconciler then reassigned
 *  ids positionally by `listen`-statement order). */
function identityKeyOf(listener: {
  movementName: string | null;
  kind: string;
  credentialsId: string | null;
  configKey: string | null;
}): string {
  return `${listener.movementName ?? ''}::${listener.kind}::${listener.credentialsId ?? ''}::${listener.configKey ?? ''}`;
}

/** The movement-BLIND identity: (adapter kind, credentials, config key). Used
 *  only as a fallback after every exact (movement-scoped) match is claimed — it
 *  reunites a listen with its row across a movement RENAME, and adopts a legacy
 *  row minted before per-movement addressing (`fired_movement_name` null). It
 *  can never steal a surviving listener's row: those are all claimed first. */
function channelConfigKeyOf(listener: {
  kind: string;
  credentialsId: string | null;
  configKey: string | null;
}): string {
  return `${listener.kind}::${listener.credentialsId ?? ''}::${listener.configKey ?? ''}`;
}

/** Looser bucket for the changed-config-updates-in-place rule. */
function channelKeyOf(listener: { kind: string; credentialsId: string | null }): string {
  return `${listener.kind}::${listener.credentialsId ?? ''}`;
}

interface ReconciliationPlan {
  /** desired[i] → the existing row it keeps, or undefined (create). */
  matches: Array<DerivedTriggerRow | undefined>;
  retired: DerivedTriggerRow[];
}

/**
 * Match desired listeners to existing derived rows:
 *   1a. exact (movement, kind, credentials, config key) identity → keep the
 *       row. A surviving listen claims its OWN row before any looser pass, so
 *       inserting/reordering movements can never reassign it.
 *   1b. movement-blind (kind, credentials, config key) → keep the row across a
 *       movement RENAME or adopt a legacy (`fired_movement_name` null) row.
 *   2.  otherwise, when exactly ONE unmatched desired listener and ONE
 *       unmatched row share (kind, credentials), the config changed in an
 *       unambiguous way → update that row in place;
 *   3.  leftover desired listeners → new rows; leftover rows → retired.
 */
export function planListenerReconciliation(input: {
  desired: Array<{
    movementName: string;
    kind: string;
    credentialsId: string | null;
    configKey: string | null;
  }>;
  existing: DerivedTriggerRow[];
}): ReconciliationPlan {
  const matches: Array<DerivedTriggerRow | undefined> = input.desired.map(() => undefined);
  const remaining = [...input.existing];

  const claim = (index: number, row: DerivedTriggerRow): void => {
    matches[index] = row;
    remaining.splice(remaining.indexOf(row), 1);
  };

  const rowConfigKeyOf = (r: DerivedTriggerRow): string | null =>
    configKeyOf(r.config, r.resolvedAddress);

  // Pass 1a — exact identity, scoped to the movement the trigger fires.
  for (let i = 0; i < input.desired.length; i++) {
    const key = identityKeyOf(input.desired[i]);
    const row = remaining.find(
      (r) =>
        identityKeyOf({
          movementName: r.firedMovementName,
          kind: r.kind,
          credentialsId: r.credentialsId,
          configKey: rowConfigKeyOf(r),
        }) === key,
    );
    if (row) claim(i, row);
  }

  // Pass 1b — movement-blind fallback: a listen whose movement was renamed (or
  // whose row predates per-movement addressing) reunites with its row here,
  // AFTER every unchanged listen has claimed its own row above.
  for (let i = 0; i < input.desired.length; i++) {
    if (matches[i]) continue;
    const key = channelConfigKeyOf(input.desired[i]);
    const row = remaining.find(
      (r) =>
        channelConfigKeyOf({
          kind: r.kind,
          credentialsId: r.credentialsId,
          configKey: rowConfigKeyOf(r),
        }) === key,
    );
    if (row) claim(i, row);
  }

  // Pass 2 — unambiguous config change within a (kind, credentials) channel.
  const unmatchedByChannel = new Map<string, number[]>();
  for (let i = 0; i < input.desired.length; i++) {
    if (matches[i]) continue;
    const key = channelKeyOf(input.desired[i]);
    unmatchedByChannel.set(key, [...(unmatchedByChannel.get(key) ?? []), i]);
  }
  for (const [channel, indexes] of unmatchedByChannel) {
    const candidates = remaining.filter((r) => channelKeyOf(r) === channel);
    if (indexes.length === 1 && candidates.length === 1) {
      claim(indexes[0], candidates[0]);
    }
  }

  return { matches, retired: remaining };
}

/** A row a run on another version names does not change what it fires: when the
 *  plan would (a movement renamed, a listen moved to another movement), the new
 *  listen takes a row of its own, and this one is retired. */
function keepWhatWaitingRunsFired(input: {
  plan: ReconciliationPlan;
  desired: ReadonlyArray<{ movementName: string }>;
  namedElsewhere: ReadonlySet<string>;
}): ReconciliationPlan {
  const retired = [...input.plan.retired];
  const matches = input.plan.matches.map((row, i) => {
    if (row === undefined || !input.namedElsewhere.has(row.id)) return row;
    if (row.firedMovementName === null || row.firedMovementName === input.desired[i].movementName) return row;
    retired.push(row);
    return undefined;
  });
  return { matches, retired };
}

/** The cell a row keeps its resolved address in. */
function resolvedAddressCell(listener: Pick<DesiredListener, 'resolvedAddress'>): never {
  return (listener.resolvedAddress !== undefined && Object.keys(listener.resolvedAddress).length > 0 ? JSON.stringify(listener.resolvedAddress) : null) as never;
}

/** The periodic reconcile that arms a listener's poll: any listen's last
 *  edge may be polled (a schedule's `Ticks` is), so every new, changed or
 *  retired listener asks for it; it is idempotent. */
function reconcileKindFor(_kind: string): Extract<WorkKind, 'poll_reconcile'> {
  return 'poll_reconcile';
}

async function reconcileDerivedTriggers(input: {
  teamId: TeamId;
  movementRow: MovementRow;
  desired: DesiredListener[];
  /** What to tell a run parked on a listener this reconciliation retires.
   *  Defaults to the ordinary case (the `listen` line went away). */
  retirementReason?: string;
  /** A language upgrade: it never changes whether anything is live, so every
   *  pause outlasts it, even where the new plan cannot be matched to its row. */
  keepPauses?: boolean;
  /** A language upgrade from a carried version: each listen takes how far its
   *  predecessor heard (./carried_cursors.ts). */
  carrying?: CarryingFrom;
}): Promise<{ listeners: ProvisionedListener[]; reconciles: Set<WorkKind>; leftPaused: string[]; cursorsNotCarried: string[] }> {
  const qb = getAutomationsQb(['trigger']);
  // Read before the rows are touched, with each held: a tick or a pull under its
  // old version committed first, or finds its row moved.
  const heard = input.carrying !== undefined ? await heardSoFarOf(input.movementRow.id) : new Map<string, HeardRow>();
  // The schedule reconciles whose rows this save made stale: a new, changed or
  // retired cron or poll. An unchanged listener is armed already.
  const reconciles = new Set<WorkKind>();
  const noteSchedule = (kind: string): void => {
    reconciles.add(reconcileKindFor(kind));
  };
  const existing = await listDerivedTriggerRows(input.movementRow.id);
  const leftovers = await listLeftoverTriggerRows(input.movementRow.id);
  const planned = planListenerReconciliation({
    desired: input.desired.map((d) => ({
      movementName: d.movementName,
      kind: d.adapter,
      credentialsId: d.credentialsId,
      configKey: configKeyOf(d.config, d.resolvedAddress),
    })),
    existing,
  });
  // A run on another version is not this text's to end: it finishes on its own
  // pin, and reads what it fired through from its row when it resumes. So its row
  // keeps firing what the run fired, and a row this text has no listen for stays
  // as a leftover rather than failing the run.
  const namedElsewhere = await triggersUnfinishedRunsName({
    triggerIds: [
      ...planned.retired,
      ...leftovers,
      ...planned.matches.flatMap((row, i) => (row !== undefined && row.firedMovementName !== input.desired[i].movementName ? [row] : [])),
    ].map((row) => row.id),
    pinnedOtherThan: input.movementRow.languageVersion,
  });
  const plan = keepWhatWaitingRunsFired({ plan: planned, desired: input.desired, namedElsewhere });
  const breakerPauses = input.keepPauses === true ? await loopBreakerPauses({ teamId: input.teamId, configs: existing.map((row) => row.config) }) : new Map<string, string>();
  const breakerPauseOf = (row: DerivedTriggerRow): string | undefined => {
    const pipeline = pipelineOfConfig(row.config);
    return pipeline === null ? undefined : breakerPauses.get(pipeline);
  };
  // A pause on a row this retires passes to the rows this makes for it
  // (`carriedPauses`).
  const retiredPauses = input.keepPauses === true
    ? plan.retired.map((row) => {
        const off = row.runMode === 'off';
        const breaker = breakerPauseOf(row);
        const pause: CarriedPause | null = off || row.guardPause !== undefined || breaker !== undefined
          ? { off, ...(row.guardPause !== undefined ? { guard: row.guardPause } : {}), ...(breaker !== undefined ? { breaker } : {}) }
          : null;
        return { identity: listenIdentityOf({ movementName: row.firedMovementName, kind: row.kind, credentialsId: row.credentialsId }), pause };
      })
    : [];
  const { predecessors, unmatched } =
    input.carrying !== undefined
      ? predecessorsOf({
          desired: input.desired.map(({ movementName, adapter, credentialsId }) => ({ movementName, adapter, credentialsId })),
          rows: existing,
          statements: input.carrying.statements,
        })
      : { predecessors: [], unmatched: [] };
  // A cursor is never lost in silence: what cannot be carried is said, by the
  // listen, in the upgrade's answer.
  const cursorsNotCarried: string[] = [];
  const cursorNotCarried = (row: { id: string; kind: string; firedMovementName: string | null; config: unknown }): void => {
    logger.warn('[LanguageUpgrade] how far a listen heard was not carried', { movementId: input.movementRow.id, triggerId: row.id, kind: row.kind, firedMovementName: row.firedMovementName });
    cursorsNotCarried.push(`${input.movementRow.name}: how far the ${row.kind} listen ${JSON.stringify(row.config)} that fired \`${row.firedMovementName ?? ''}\` had heard was not carried: it could not be told from the automation's other listens, or its place could not be read. It starts from its first poll, so what arrived after its last poll or tick under its earlier version is not delivered.`);
  };
  for (const row of unmatched) {
    if (heardAnything(heard.get(row.id))) cursorNotCarried(row);
  }
  const carriedCursors: CarriedListen['cursors'] = [];
  const freshIndexes = input.desired.flatMap((_, i) => (plan.matches[i] === undefined ? [i] : []));
  const carried = new Map(
    carriedPauses({
      retired: retiredPauses,
      fresh: freshIndexes.map((i) => ({ identity: listenIdentityOf({ movementName: input.desired[i].movementName, kind: input.desired[i].adapter, credentialsId: input.desired[i].credentialsId })! })),
    }).map((carry, n) => [freshIndexes[n]!, carry] as const),
  );
  const leftPaused: string[] = [];

  // Retire rows whose listen disappeared: delete the trigger row itself.
  // `trigger_run` history rows reference the trigger id WITHOUT an FK, so
  // they survive as orphans — the firing record outlives the listener, it
  // just no longer resolves to a row.
  //
  // A run PARKED against a retired trigger can never resume: every resume
  // driver (await/timer/callback) loads the trigger row first and bails when
  // it is gone, leaving the run parked forever with nothing said. This save
  // is the last actor that knows the work is being dropped, so settle those
  // runs first — the same duty `deleteMovement` discharges, for the same
  // reason (../../interaction/run_failure.ts).
  const deleted = [...plan.retired.filter((row) => !namedElsewhere.has(row.id)), ...leftovers.filter((row) => !namedElsewhere.has(row.id))];
  if (deleted.length > 0) {
    await settleRunsParkedOnTriggers({
      triggerIds: deleted.map((row) => row.id),
      reason:
        input.retirementReason ??
        'This run was still waiting to continue when its listener was removed from the automation, so it was stopped.',
    });
  }
  for (const row of deleted) {
    noteSchedule(row.kind);
    await qb
      .deleteFrom('trigger')
      .where('id', '=', row.id as TriggerId)
      .execute();
  }
  // A row that stays only for a run on another version still ends this version's:
  // its listen is gone, as for a row deleted above.
  const keptForOthers = plan.retired.filter((retired) => namedElsewhere.has(retired.id));
  if (keptForOthers.length > 0) {
    await settleRunsParkedOnTriggers({
      triggerIds: keptForOthers.map((row) => row.id),
      pinned: input.movementRow.languageVersion,
      reason: input.retirementReason ?? 'This run was still waiting to continue when its listener was removed from the automation, so it was stopped.',
    });
  }
  for (const row of keptForOthers) {
    noteSchedule(row.kind);
    await qb
      .updateTable('trigger')
      .set({ config: leftoverTriggerConfig(row.config) as never, resolved_address: null, credentials_id: null, run_mode: 'off', updated_at: new Date() })
      .where('id', '=', row.id as TriggerId)
      .execute();
  }

  const listeners: ProvisionedListener[] = [];
  for (let i = 0; i < input.desired.length; i++) {
    const kept = plan.matches[i];
    const rowId = kept?.id ?? randomUUID();
    const moved =
      input.carrying !== undefined
        ? carriedListen({
            carrying: input.carrying,
            config: input.desired[i].config,
            listen: { triggerId: rowId as TriggerId, teamId: input.teamId, file: input.movementRow.name, credentialsId: input.desired[i].credentialsId },
            heard: predecessors[i] !== null && predecessors[i] !== undefined ? heard.get(predecessors[i]!.id) : undefined,
            pollSubscriptionId,
          })
        : undefined;
    if (moved !== undefined) carriedCursors.push(...moved.cursors);
    if (moved?.notCarried === true) cursorNotCarried(predecessors[i]!);
    const desired: DesiredListener = {
      ...input.desired[i],
      config: moved?.config ?? (kept !== undefined ? keepingCarriedFrom(input.desired[i].config, kept.config) : input.desired[i].config),
    };
    const name = desired.alias ?? `movement/${input.movementRow.name}/${desired.movementName}`;

    // run_mode semantics: the dry_run⇄live axis is TEXT-DERIVED — a listener
    // whose movement writes only `dry_run: true` instances rehearses (engine
    // dryRun via the trigger run_mode mechanism), and removing the dry_run
    // flags returns it to live on the next save. This reconciliation is now
    // the ONLY writer of run_mode: the operator pause that also owned this
    // column was retired, so pausing is commenting the `listen` line out.
    const textRunMode: TriggerRunMode = desired.textRunMode;
    let triggerId: string;
    let runMode: TriggerRunMode;
    if (kept) {
      // Routing identity refreshes in place; a pre-existing 'off' is KEPT.
      // Nothing can set 'off' any more, but rows predating the retirement of
      // the operator pause must not silently resume — a save is not consent
      // to start running again. See triggers/run_mode.ts.
      triggerId = kept.id;
      if (
        kept.kind !== desired.adapter ||
        !isDeepStrictEqual(kept.config, desired.config)
      ) {
        noteSchedule(kept.kind);
        noteSchedule(desired.adapter);
      }
      runMode =
        kept.runMode === 'off' ? 'off'
        : textRunMode === 'dry_run' ? 'dry_run'
        : kept.runMode === 'dry_run' ? 'live'
        : kept.runMode;
      await qb
        .updateTable('trigger')
        .set({
          name,
          kind: desired.adapter,
          credentials_id: (desired.credentialsId ?? null) as never,
          config: desired.config as never,
          resolved_address: resolvedAddressCell(desired),
          movement_id: input.movementRow.id as MovementId,
          fired_movement_name: desired.movementName,
          run_mode: runMode,
          updated_at: new Date(),
        })
        .where('id', '=', triggerId as TriggerId)
        .execute();
      const held = breakerPauseOf(kept);
      if (held !== undefined) await pauseListenConfig({ teamId: input.teamId, config: desired.config, reason: held });
    } else {
      triggerId = rowId;
      const carry = carried.get(i);
      const carriedGuard = carry?.pause?.guard;
      const carriedBreaker = carry?.pause?.breaker;
      runMode = carry?.pause?.off === true ? 'off' : textRunMode;
      if (carry?.unsure === true) leftPaused.push(`${input.movementRow.name}: the ${desired.adapter} listen that fires ${desired.movementName} was left paused: it could not be told which of the automation's earlier listens was the one paused, and a paused listen is never started by an upgrade. Resume it if it is the one you want running.`);
      noteSchedule(desired.adapter);
      await qb
        .insertInto('trigger')
        .values({
          id: triggerId as TriggerId,
          team_id: input.teamId,
          name,
          kind: desired.adapter,
          config: desired.config as never,
          resolved_address: resolvedAddressCell(desired),
          credentials_id: (desired.credentialsId ?? null) as never,
          movement_id: input.movementRow.id as MovementId,
          fired_movement_name: desired.movementName,
          run_mode: runMode,
          provisioned_by_setup_agent: false,
          ...(carriedGuard !== undefined
            ? { guard_paused_at: carriedGuard.at, guard_paused_reason: carriedGuard.reason, guard_paused_signal: carriedGuard.signal }
            : {}),
        } as never)
        .execute();
      if (carriedBreaker !== undefined) await pauseListenConfig({ teamId: input.teamId, config: desired.config, reason: carriedBreaker });
    }

    // The trigger row is purely the dispatch index — dispatch executes the
    // canonical text. It carries no orchestration / object code; liveness
    // derives from `movement_id` being set (storage/authored.ts).
    const configKey = surfaceConfigKeyOf(desired.config);
    listeners.push({
      triggerId,
      movementName: desired.movementName,
      kind: desired.adapter,
      credentialsId: desired.credentialsId,
      config: desired.config,
      configKey,
      inboundAddress: inboundAddressOf(desired.config),
      runMode,
      reused: kept !== undefined,
    });
  }
  await keepCarriedCursors(input.teamId, carriedCursors);
  return { listeners, reconciles, leftPaused, cursorsNotCarried };
}

// ── Provision: check the program, then reconcile the listeners ──────────────

/** A carried version's listens: its own collection of them, kept as production's
 *  rows kept them, read and judged only by that version (carried_delivery.ts). As
 *  production's save did: each listen's address is resolved before any row is
 *  touched, and a listen that does not resolve refuses the save, or ships without
 *  an address on a consented one; its run mode is what the text says; its schedule
 *  or poll is armed, and its webhook is reached for through the version's own
 *  module. */
async function provisionCarriedListeners(input: {
  teamId: TeamId;
  audience: CatalogAudience;
  movementRow: MovementRow;
  source: string;
  lane: ListeningLane;
  keepPauses?: boolean;
  provisionDespiteErrors?: boolean;
  providersLater?: boolean;
  timer?: StepTimer;
  notes: string[];
}): Promise<ProvisionMovementResult> {
  const pin = input.movementRow.languageVersion;
  const { lane } = input;
  const within = <T>(name: string, run: () => Promise<T>): Promise<T> => (input.timer ? input.timer.within(name, run) : run());
  const team = await teamFactsOf(input.teamId, { imports: 'live', audience: input.audience });
  const credentialOf = (name: string): string | null => team.credentials.find((row) => row.name === name)?.id ?? null;
  // A text its version cannot parse states no listens: answered as the current
  // version's save answers it. The class is that version's own, so it is read by name.
  let statements: ReturnType<ListeningLane['listenersOf']>;
  try {
    statements = lane.listenersOf({ source: input.source, pin });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'MovementParseError') throw error;
    const at = { line: 1, col: 1 };
    return { ok: false, diagnostics: [{ code: 'MOV_PARSE', message: error.message, span: { start: at, end: at } }], catalogNotes: input.notes };
  }
  const desired: DesiredListener[] = statements.map((statement) => ({
    movementName: statement.movementName,
    adapter: statement.adapter,
    ...(statement.alias !== undefined ? { alias: statement.alias } : {}),
    config: statement.config,
    textRunMode: lane.writeRunModeOf({ source: input.source, pin, movementName: statement.movementName }),
    credentialsId: statement.credentialName !== undefined ? credentialOf(statement.credentialName) : null,
  }));
  const addressFailures: string[] = [];
  await within('listenAddress', async () => {
    for (const [index, listener] of desired.entries()) {
      const statement = statements[index];
      try {
        const resolution = await lane.resolveListenAddress(
          {
            teamId: input.teamId,
            adapter: listener.adapter,
            credentialsId: listener.credentialsId,
            ...(statement.constructionArgs !== undefined ? { constructionArgs: statement.constructionArgs } : {}),
            config: statement.config,
          },
          modulePlatform(),
        );
        if (resolution.ok) listener.resolvedAddress = resolution.address;
        else addressFailures.push(`the '${listener.adapter}' listener firing '${listener.movementName}': ${resolution.reason}`);
      } catch (err) {
        addressFailures.push(`the '${listener.adapter}' listener firing '${listener.movementName}': address resolution failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  });
  if (addressFailures.length > 0 && input.provisionDespiteErrors !== true) {
    return { ok: false, errors: addressFailures, catalogNotes: input.notes };
  }
  const { listeners, reconciles, leftPaused } = await within('reconcile', () =>
    reconcileDerivedTriggers({
      teamId: input.teamId,
      movementRow: input.movementRow,
      desired,
      ...(input.keepPauses === true ? { keepPauses: true } : {}),
    }),
  );
  // A carried version's schedule is armed by its own reconcile; it too is idempotent.
  for (const kind of reconciles.size > 0 ? ([...reconciles, 'cron_reconcile'] as const) : []) await enqueueWork({ kind, key: `${kind}:shipped` });
  // Inside a caller's transaction the providers are left to its work row.
  const subscriptionNotes = input.providersLater === true ? [] : (await within('subscriptionSync', () => syncListenSubscriptions({ teamId: input.teamId }))).notes;
  return {
    ok: true,
    movementName: input.movementRow.name,
    listeners,
    infos: [],
    catalogNotes: [...input.notes, ...subscriptionNotes],
    warnings: [],
    ...(leftPaused.length > 0 ? { leftPaused } : {}),
  };
}

async function provisionListeners(input: {
  teamId: TeamId;
  movementRow: MovementRow;
  source: string;
  teamCatalog: TeamMovementCatalog;
  /** A CONSENTED non-valid save still SHIPS (decision 3b) — derive its
   *  listeners from the parse despite check errors, so the declared listens
   *  exist and the movement genuinely fires-and-fails. Collection is already
   *  defensive: unresolvable pieces are skipped. */
  provisionDespiteErrors?: boolean;
  /** The save's timer, when this runs under one — the two network-backed
   *  halves (address resolution, subscription sync) are reported inside the
   *  `listeners` step rather than hidden in it (./timing.ts). */
  timer?: StepTimer;
  /** Inside a caller's open transaction those two halves are left to the
   *  caller's work row (./listens_up.ts): no provider is called while it is
   *  open or for a rollback. */
  providersLater?: boolean;
  /** A language upgrade: see `reconcileDerivedTriggers`. */
  keepPauses?: boolean;
  /** An upgrade moving from a carried version: its doors lock is held, as of this
   *  instant. */
  movedAt?: Date;
}): Promise<ProvisionMovementResult> {
  const { teamCatalog } = input;
  const within = <T>(name: string, run: () => Promise<T>): Promise<T> =>
    input.timer ? input.timer.within(name, run) : run();

  const route = routeOf(input.movementRow.languageVersion);
  if (route.kind === 'refused' || route.kind === 'dropped') {
    return { ok: false, diagnostics: [route.diagnostic], catalogNotes: teamCatalog.notes };
  }
  if (route.kind === 'carried') {
    return { ok: false, diagnostics: [notListenedDiagnostic(route.pin)], catalogNotes: teamCatalog.notes };
  }
  // A legacy pin's listens cannot fire under this release: inbound judges by
  // the listen plans only this release's checker makes. It is refused by
  // name until it is upgraded.
  if (route.kind === 'legacy') {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'MOV_LANGUAGE_VERSION_UNSUPPORTED',
          message: `this automation is pinned to language version ${route.pin}, whose listens this release no longer runs: upgrade it to ${LANGUAGE_VERSION}`,
          span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
        },
      ],
      catalogNotes: teamCatalog.notes,
    };
  }
  let program: Program;
  try {
    program = parseInstalled(input.source, { languageVersion: route.pin });
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    return {
      ok: false,
      diagnostics: [
        { code: 'MOV_PARSE', message: e.message, span: { start: e.loc, end: e.loc } },
      ],
      catalogNotes: teamCatalog.notes,
    };
  }

  const snapshot = teamCatalog.runSnapshot?.();
  if (snapshot === undefined) throw new Error('a release pin is checked against its run snapshot');
  const checkDiagnostics = await within('listenCheck', async () => checkInstalled({ source: input.source, snapshot, pin: route.pin }));
  const errors = checkDiagnostics.filter((d) => (d.severity ?? 'error') === 'error');
  const infos = checkDiagnostics.filter((d) => (d.severity ?? 'error') !== 'error');
  if (errors.length > 0 && input.provisionDespiteErrors !== true) {
    return { ok: false, diagnostics: checkDiagnostics, catalogNotes: teamCatalog.notes };
  }

  /** The text-derived dry_run⇄live axis. */
  const textRunModeOf = (
    movementName: string,
  ): Extract<TriggerRunMode, 'live' | 'dry_run'> =>
    movementWriteRunMode(program, movementName).mode === 'dry_run' ? 'dry_run' : 'live';

  // Each listen as the check plans it: the trigger row is its projection.
  const planned = plannedListensOfSource({ file: input.movementRow.name, source: input.source, program, snapshot, pin: route.pin });
  if (planned.refused.length > 0 && input.provisionDespiteErrors !== true) {
    return { ok: false, errors: planned.refused, catalogNotes: teamCatalog.notes };
  }
  const desired: DesiredListener[] = planned.listens.map((listen) => ({
    movementName: listen.plan.movement,
    adapter: listen.plan.adapter,
    ...(listen.plan.alias !== undefined ? { alias: listen.plan.alias } : {}),
    config: { listen },
    textRunMode: textRunModeOf(listen.plan.movement),
    credentialsId:
      listen.credentialName !== undefined
        ? (teamCatalog.resolveCredentialId(listen.credentialName) ?? null)
        : null,
  }));

  const carrying = input.movedAt !== undefined ? await carryingFromShipped(input.movementRow, input.movedAt) : undefined;
  const { listeners, reconciles, leftPaused, cursorsNotCarried } = await within('reconcile', () =>
    reconcileDerivedTriggers({
      teamId: input.teamId,
      movementRow: input.movementRow,
      desired,
      ...(input.keepPauses === true ? { keepPauses: true } : {}),
      ...(carrying !== undefined ? { carrying } : {}),
    }),
  );

  // Under the wake the drain is a job started on demand: a new schedule would
  // wait for the next hourly safety tick to be armed. Ask for the reconcile now.
  // Its own one-shot row, not the periodic one: while a drain holds the
  // periodic row's lease, a request on that key is pushed to the next interval.
  for (const kind of reconciles) await enqueueWork({ kind, key: `${kind}:shipped` });

  const reachProviders = async (): Promise<string[]> => {
    // A listen the host lists the members of (Airtable narrowed by base or
    // table) is listed now, before its subscriptions are synced, so they are
    // made per record it is subscribed under (its base); the clock relist is
    // armed with it (listen_resolve.ts). Read off the reconcile's own rows, not
    // the store, so no listen re-read is owed. A failure keeps the listen saved
    // and surfaces as a note, never blocks the save.
    await within('resolveListens', async () => {
      for (const listener of listeners) {
        const parsed = listenConfigSchema.safeParse(listener.config);
        if (!parsed.success || !resolvesListen(parsed.data.listen)) continue;
        const listen: SavedListen = { ...parsed.data.listen, triggerId: listener.triggerId as TriggerId, teamId: input.teamId as TeamId, file: input.movementRow.name, credentialsId: listener.credentialsId };
        await resolveAndArm(listen);
      }
    });

    // External event subscriptions follow the listens: the trigger table is
    // now the desired state, so the global per-team diff-sync (attio
    // webhooks et al — Adapter.ensureEventSubscription) runs after every
    // reconcile. Failures surface as notes, never block the save.
    const subscriptionSync = await within('subscriptionSync', () =>
      syncListenSubscriptions({ teamId: input.teamId }),
    );
    return subscriptionSync.notes;
  };

  const subscriptionNotes = input.providersLater === true ? [] : await reachProviders();

  return {
    ok: true,
    movementName: input.movementRow.name,
    listeners,
    infos,
    catalogNotes: [...teamCatalog.notes, ...subscriptionNotes],
    // Save-time warnings are assembled by `saveMovement` — provisioning
    // itself has no view of the rest of the team's automations.
    warnings: [],
    ...(leftPaused.length > 0 ? { leftPaused } : {}),
    ...(cursorsNotCarried.length > 0 ? { cursorsNotCarried } : {}),
  };
}

// ── Text-canonical persistence (saveMovement & friends) ────────────────────

/**
 * A save joining a caller's open database transaction (an upgrade's import
 * group). It writes only to the database, through that transaction. The caller
 * assembled its catalog before the transaction opened (the one provider read a
 * save needs up front), and owes the providers the rest as a work row in the
 * same transaction (./listens_up.ts). A rollback leaves nothing at a provider
 * and tells nobody.
 */
export interface SaveInTransaction {
  teamCatalog: TeamMovementCatalog;
}

export interface SaveMovementInput {
  teamId: string;
  /** The movement program text — the canonical artifact. */
  source: string;
  /** Whose save this is: the connections its check, and its listens, may
   *  resolve. A person's save is also decided for them (./save_access.ts). */
  audience: CatalogAudience;
  /** Who may read and write the automation, when this save creates it, and who
   *  may use it when it exports (the use list alone may also be given by a save
   *  that adds a file's first export). A person's save that creates one without
   *  them is refused. */
  statements?: Partial<CreationStatements>;
  /** Existing movement row id (the editor's re-save path). */
  id?: string;
  /** Set when the caller means to create a new automation, never to overwrite: a name that is already held is then refused as taken, whoever the saver is and whatever they may do to the automation holding it. */
  intent?: 'create';
  /** The row's name (the `<file>` half of the trigger-name convention).
   *  Defaults to the source's first movement declaration. */
  name?: string;
  description?: string;
  userId?: string;
  /** The `updatedAt` (ISO) the editor loaded. When set on a re-save and
   *  the stored row has moved on since — the assistant or another session
   *  saved in the meantime — the save is refused as a CONFLICT rather than
   *  silently overwriting. Omit to force an overwrite. */
  baseUpdatedAt?: string;
  /** Content-hash precondition (the `revision` a caller's earlier `getMovement`
   *  returned — `movementSourceHash` of the CURRENT source). When set on a
   *  re-save and the stored row's current source no longer hashes to it —
   *  someone else saved a newer version in the meantime — the save is refused
   *  as a CONFLICT, same shape as `baseUpdatedAt`'s guard, so the caller can
   *  re-read and merge rather than silently clobber it. Independent of
   *  `baseUpdatedAt`: this is the agent-facing precondition (an MCP caller has
   *  no editor "loaded at" timestamp to carry, but can always carry the last
   *  hash it read) — content-keyed rather than clock-keyed, and unaffected by
   *  clock skew. Omit for today's behaviour (no precondition, last write wins). */
  expectedRevision?: string;
  /** Marks the resource-change event so the open editor reflects agent
   *  saves live (default 'user' for direct edits). */
  changeSource?: 'agent' | 'user';
  /** Explicit consent to save a non-`valid` movement (invalid/unverified/
   *  incompilable) live anyway. Without it, such a save returns
   *  `needsConfirmation` so the caller can self-repair or confirm with the
   *  user. See plans/2026-07-13-movement-validity-lifecycle. */
  acknowledgeErrors?: boolean;
  /** Set only by the language upgrade (language_upgrade.ts): this text is the
   *  movement rewritten into version `to`, and it saves under that version —
   *  the pin and the text it is written in move in the one row update. An
   *  ordinary save never moves the pin. */
  languageUpgrade?: {
    to: LanguageVersion;
    /** The upgrade's instant, with the team's doors held: a move from a carried
     *  version takes how far its listens heard as of then. */
    movedAt?: Date;
  };
  /** Set only by the language upgrade: the save joins its open transaction. */
  inTransaction?: SaveInTransaction;
}

export interface SavedMovement extends ProvisionedMovement {
  movementId: string;
  /** The runtime validity the save shipped at — `valid`, or the consented
   *  non-`valid` state (decision 3b: a consented broken save replaces what
   *  runs and fires-and-fails). */
  validity: MovementValidityAssessment;
}

export interface SaveMovementFailure extends ProvisionMovementFailure {
  /** Absent only when no row could be saved (no derivable name). */
  movementId?: string;
  /** The stored row changed since the editor loaded — nothing was saved.
   *  The caller can show the current version and let the user reload it or
   *  overwrite (re-save with no baseUpdatedAt). */
  conflict?: {
    currentSource: string;
    currentUpdatedAt: string;
    /** Present when the conflict was detected by `expectedRevision` (or
     *  always computable regardless) — the CURRENT content hash, so a caller
     *  that wants to skip a redundant `getMovement` round-trip can re-save
     *  straight off it once it has merged. */
    currentRevision?: string;
  };
  /** A person's save that was not theirs to make; `errors` says why. Nothing
   *  was stored. */
  refused?: SaveRefusal;
  /** The save landed non-`valid` and no consent was given: the source is
   *  persisted (retained artifact) but not shipped live. The caller either
   *  self-repairs off `validity.reason` or re-calls with `acknowledgeErrors`. */
  needsConfirmation?: boolean;
  /** The runtime validity the save was assessed at (present on a
   *  `needsConfirmation` return). */
  validity?: MovementValidityAssessment;
}

export type SaveMovementResult = SavedMovement | SaveMovementFailure;

/** One save, two milestones, gated differently — deliberately asymmetric
 *  (plans/2026-07-16-journey-instrumentation/design.md, "Monotonicity"):
 *
 *  - USER milestone: fires ONLY when this save arrived via MCP
 *    (`x-mcp-domain: automation`, stamped on the request Context by the auth
 *    middleware). The user journey measures *this person's* MCP adoption —
 *    an automation authored in the web UI never touches MCP, so counting it
 *    here could let `first_automation_saved` outrun `first_mcp_call` and
 *    render a negative drop-off. Gating to MCP-only keeps it monotonic by
 *    construction: an MCP save already stamped `first_mcp_call` earlier in
 *    this same request. Also skipped when no acting user is known (e.g. an
 *    unattended seed script).
 *  - TEAM milestone: fires on ANY route, unconditionally. The team journey
 *    measures the account coming to life regardless of how — gating it to
 *    MCP would reintroduce the same negative-drop-off problem one step
 *    later (a web-UI-authored automation that runs would show `first_run`
 *    with no save). The team-level event is silent by design — see
 *    lib/journey/types.ts:teamMilestoneTitle.
 *
 *  Fire-and-forget throughout: a journey failure must never fail a save. */
function recordAutomationSavedMilestones(input: {
  actingUserId?: string;
  teamId: string;
  viaMcp: boolean;
}): void {
  if (input.actingUserId && input.viaMcp) {
    void recordUserMilestone(input.actingUserId, {
      milestone: 'first_automation_saved',
      teamId: input.teamId,
    }).catch((e) => logger.warn('journey: first_automation_saved (user) failed', { error: e }));
  }
  void recordTeamMilestone(input.teamId, {
    milestone: 'first_automation_saved',
  }).catch((e) => logger.warn('journey: first_automation_saved (team) failed', { error: e }));
}

/** The source's own movement declarations — or NULL when the source cannot be
 *  read at all (an unparseable draft declares nothing we can trust, which is a
 *  different fact from declaring none). A name reader, not a verdict: the
 *  installed parser reads the declarations of any pin's text. */
function declaredMovementNames(source: string): string[] | null {
  try {
    return parseInstalled(source)
      .statements.filter((s): s is MovementDeclaration => s.kind === 'movement')
      .map((s) => s.name);
  } catch (e) {
    if (e instanceof MovementParseError) return null;
    throw e;
  }
}

/**
 * Warn when a movement name this file declares is ALREADY being fired by
 * another automation in the team.
 *
 * Nothing about registration is ambiguous: trigger identity is
 * `movement/<file>/<movement>` and reconciliation is scoped to the movement
 * ROW, so the two files' listeners are separate rows and neither shadows the
 * other. What breaks is the AUTHOR's mental model — they edit `notify` here,
 * watch the other file's `notify` listener keep firing, and conclude the save
 * did nothing (the live debugging session this came out of). So this is
 * purely visibility: a warning, never an error, and never a change to what
 * gets registered.
 */
async function movementNameCollisionWarnings(input: {
  teamId: string;
  movementId: string;
  declaredNames: string[];
}): Promise<string[]> {
  const collisions = await listenersFiringMovementNames({
    teamId: input.teamId,
    movementNames: input.declaredNames,
    excludeMovementId: input.movementId,
  });
  // One warning per (name, other file) — several listeners of the other file
  // firing the same name is one fact, not three.
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const collision of collisions) {
    const key = `${collision.firedMovementName} ${collision.movementId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(
      collision.runMode === 'live'
        ? `The movement name "${collision.firedMovementName}" is also used by another automation, "${collision.movementFileName}", whose listener for it is live — that listener fires the other automation's version, not this one.`
        : `The movement name "${collision.firedMovementName}" is also used by another automation, "${collision.movementFileName}". Its listener for that name is not live, so nothing fires it from there today.`,
    );
  }
  return warnings;
}

/**
 * Save a movement file: write the canonical source row FIRST, then gate +
 * reconcile the derived listeners. The gate is the runtime-validity
 * consent gate (decision 3b) — execution reads THIS text through the
 * movement engine:
 *
 *   non-`valid`, no consent → `needsConfirmation` (text saved as a
 *     retained artifact; what's RUNNING is unchanged);
 *   `valid` or consented → the save SHIPS: derived triggers now mirror
 *     the file's listen statements exactly (zero listens = library, no
 *     triggers) and a version is minted.
 */
/** A save's check, under the row's pin — which a re-save never moves. */
interface SaveCheck {
  validation: MovementValidation;
  validity: MovementValidityAssessment;
  notes: string[];
  gaps: CatalogGap[];
  /** This release's catalog, which the listeners are provisioned from;
   *  absent for a pin a carried version checks, whose catalog is its own. */
  teamCatalog?: TeamMovementCatalog;
}

async function checkForSave({ input, row, timer }: { input: SaveMovementInput; row: MovementRow; timer: StepTimer }): Promise<SaveCheck> {
  // A pin a carried version checks is validated by that version's own checker
  // against its own catalog; this release's catalog is never assembled for it.
  const route = routeOf(row.languageVersion);
  if (route.kind === 'carried') {
    const checked = await timer.step('diagnose', () =>
      validateUnderCarried({ teamId: input.teamId, source: input.source, pin: route.pin, lane: route.lane, audience: input.audience }),
    );
    const carried = { ...checked, diagnostics: await hideUnreadableLibraries(checked.diagnostics, input) };
    return {
      validation: carried,
      validity: assessMovementValidity({ diagnostics: carried.diagnostics, gaps: carried.gaps }),
      notes: carried.catalogNotes,
      gaps: carried.gaps,
    };
  }

  // Referenced-set catalog: introspect only the (adapter, credential)
  // pairs this program (and its imported libraries) constructs, not the
  // whole workspace. A save inside a transaction was handed the one its caller
  // assembled before opening it: no provider is read while it is open.
  const teamCatalog = input.inTransaction?.teamCatalog ?? (await timer.step('catalog', () =>
    movementCatalogForTeam(input.teamId as TeamId, {
      audience: input.audience,
      source: input.source,
      languageVersion: row.languageVersion,
    }),
  ));
  timer.note(teamCatalog.cost ?? {});

  // Runtime validity (plans/2026-07-13-movement-validity-lifecycle): assess the
  // source against the adapters' live shape using the catalog we just built (no
  // second introspection). Records the validity axis on the row. NOTHING
  // hard-blocks: a non-`valid` save without consent returns
  // `needsConfirmation` (source already persisted, so the broken movement is
  // retained as an artifact), never a wall.
  const diagnosed = await timer.step('diagnose', async () =>
    diagnoseMovementSource(input.source, {
      catalog: teamCatalog.catalog,
      resolveCredentialId: teamCatalog.resolveCredentialId,
      resolveFile: teamCatalog.resolveFile,
      languageVersion: row.languageVersion,
      ...(teamCatalog.runSnapshot !== undefined ? { snapshot: teamCatalog.runSnapshot() } : {}),
      ...(teamCatalog.importsAcrossVersions !== undefined ? { importsAcrossVersions: teamCatalog.importsAcrossVersions } : {}),
    }),
  );
  const validation = { ...diagnosed, diagnostics: await hideUnreadableLibraries(diagnosed.diagnostics, input) };
  return {
    validation,
    validity: assessMovementValidity({ diagnostics: validation.diagnostics, gaps: teamCatalog.gaps }),
    notes: teamCatalog.notes,
    gaps: teamCatalog.gaps,
    teamCatalog,
  };
}

/** What tells anyone waits for an open context transaction to commit, when
 *  there is one; a rollback told nobody. */
function onceCommitted(tell: () => void): void {
  const context = unsafeCurrentContext();
  if (context?.kyselyTrx !== undefined) context.onChangesCommitted(tell);
  else tell();
}

/**
 * Move a never-shipped automation's text and pin, and nothing else: it stays
 * never-shipped, with no listens and no version, because an upgrade never
 * starts anything. Its next ordinary save ships it, under the new pin.
 */
export async function moveNeverShippedPin(input: { teamId: string; id: string; name: string; source: string; to: LanguageVersion }): Promise<void> {
  const row = await writeMovementRow({
    teamId: input.teamId,
    intent: { kind: 'overwrite', id: input.id },
    name: input.name,
    source: input.source,
    languageVersion: input.to,
  });
  onceCommitted(() => emitMovementChange({ teamId: input.teamId, movementId: row.id, action: 'saveMovement' }));
}

export async function saveMovement(input: SaveMovementInput): Promise<SaveMovementResult> {
  // One timing line per save, whatever gate it returns through — the authoring
  // loop's latency signal (./timing.ts). The steps live in `runSave`; the
  // emit lives here so no early return can skip it.
  const timer = stepTimer('authoring: save', { teamId: input.teamId });
  try {
    const result = await runSave(input, timer);
    timer.done({
      ok: result.ok,
      ...(result.movementId !== undefined ? { movementId: result.movementId } : {}),
      ...(result.ok ? {} : { needsConfirmation: result.needsConfirmation === true }),
    });
    return result;
  } catch (error) {
    timer.done({ ok: false, threw: true });
    throw error;
  }
}

async function runSave(
  input: SaveMovementInput,
  timer: StepTimer,
): Promise<SaveMovementResult> {
  if (input.inTransaction !== undefined && unsafeCurrentContext()?.kyselyTrx === undefined) {
    throw new Error('a save handed a transaction to join is running outside one');
  }
  const declaredName = movementNameFromSource(input.source);
  const existing = input.id
    ? await getMovementRow({ teamId: input.teamId, id: input.id })
    : null;
  const missing = (id: string): SaveMovementFailure => ({ ok: false, errors: [`movement ${id} not found`], catalogNotes: [] });
  const refused = (refusal: SaveRefusal, message: string): SaveMovementFailure => ({
    ok: false,
    errors: [message],
    catalogNotes: [],
    refused: refusal,
  });
  if (input.id !== undefined && !existing) return missing(input.id);
  // Decided before the guards below, which hand back the stored text.
  const saver = saverOf(input.audience);
  if (saver !== undefined && input.id !== undefined && existing) {
    const refusal = await overwriteRefusal(saver, existing);
    if (refusal === 'unseen') return missing(input.id);
    if (refusal === 'read_only') return refused({ kind: 'read_only' }, READ_ONLY_REFUSAL);
  }
  // Optimistic-concurrency guard: if the editor loaded an older version
  // than what's stored, something saved underneath it (the assistant, or
  // another tab/teammate). Refuse rather than clobber; hand back the
  // current version so the caller can reload or deliberately overwrite.
  if (input.id !== undefined && input.baseUpdatedAt !== undefined && existing) {
    if (existing.updatedAt.getTime() > new Date(input.baseUpdatedAt).getTime()) {
      return {
        ok: false,
        errors: [
          'This movement changed since you opened it — your save was held back so it doesn’t overwrite the newer version.',
        ],
        catalogNotes: [],
        movementId: existing.id,
        conflict: {
          currentSource: existing.source,
          currentUpdatedAt: existing.updatedAt.toISOString(),
          currentRevision: movementSourceHash(existing.source),
        },
      };
    }
  }
  // Content-hash precondition (the agent-facing analogue of the guard above —
  // see `expectedRevision` doc): reject a re-save whose caller's copy no
  // longer matches what's stored, rather than silently overwriting a newer
  // edit (the prod incident this guards against: a customer's agent held a
  // stale copy and clobbered a manual edit made in between).
  if (input.id !== undefined && input.expectedRevision !== undefined && existing) {
    const currentRevision = movementSourceHash(existing.source);
    if (currentRevision !== input.expectedRevision) {
      return {
        ok: false,
        errors: [
          'This automation changed since you read it — call getAutomation again, merge your changes into the latest version, and re-save with the new revision.',
        ],
        catalogNotes: [],
        movementId: existing.id,
        conflict: {
          currentSource: existing.source,
          currentUpdatedAt: existing.updatedAt.toISOString(),
          currentRevision,
        },
      };
    }
  }
  // The display name is durable and user-owned: an explicit name (a rename)
  // wins, then the stored name persists across re-saves, and the declaration
  // only SEEDS the name on first save. Editing the declaration changes the fire
  // target — never the saved movement's name. (`name` is undefined only when a
  // brand-new file declares no movement and the caller passed no name → the
  // guard below.)
  const name = input.name ?? existing?.name ?? declaredName;
  if (name === undefined) {
    return {
      ok: false,
      errors: [
        "Add a movement declaration — `movement <name>(item: source.<position>) { … }` — so this script can be saved under its name",
      ],
      catalogNotes: [],
    };
  }

  // What this write is, decided once here and handed to the store as it is: a
  // save by name over an automation overwrites it, so it is a write on it like
  // a save by id; one that names nothing there creates it, with its statements.
  const over = existing ?? (await getMovementRowByName({ teamId: input.teamId, name }));
  const intent: MovementWriteIntent = over === null ? { kind: 'create' } : { kind: 'overwrite', id: over.id };
  // A caller who means to create never overwrites: a held name is taken, and
  // what the saver may do to its holder is not for this save to tell them.
  if (input.intent === 'create' && over !== null) return refused({ kind: 'name_taken', name }, nameTakenRefusal(name));
  let creating: CreationStatements | undefined;
  let firstUse: CreationStatements['use'];
  let named: Awaited<ReturnType<typeof connectionsNamed>> = [];
  const exporting = exportsSomething(input.source);
  if (saver !== undefined) {
    if (over !== null && existing === null) {
      const refusal = await overwriteRefusal(saver, over);
      // A name is unique in its team, so one held by an automation the saver may
      // not see can only be refused as taken. That says a name is in use, never
      // what holds it.
      if (refusal === 'unseen') return refused({ kind: 'name_taken', name }, nameTakenRefusal(name));
      if (refusal === 'read_only') return refused({ kind: 'read_only' }, READ_ONLY_REFUSAL);
    }
    // The save that adds a file's first export is the one that states its use
    // list: there is no default, and it is the one statement an overwrite may carry.
    const firstExport = over !== null && exporting && !(await hasUseList(input.teamId, over.id));
    if (over !== null && input.statements !== undefined) {
      const onlyTheUseList = input.statements.read === undefined && input.statements.write === undefined && input.statements.use !== undefined;
      if (!(firstExport && onlyTheUseList)) {
        return refused({ kind: 'statement', reason: 'on_overwrite', message: STATEMENTS_ON_OVERWRITE_REFUSAL }, STATEMENTS_ON_OVERWRITE_REFUSAL);
      }
    }
    if (firstExport) {
      if (input.statements?.use === undefined) {
        return refused({ kind: 'statement', reason: 'first_export', message: FIRST_EXPORT_REFUSAL }, FIRST_EXPORT_REFUSAL);
      }
      try {
        await checkedList(input.teamId, { verb: 'use', grantees: input.statements.use });
      } catch (error) {
        if (!(error instanceof StatementRefusedError)) throw error;
        return refused({ kind: 'statement', reason: error.refusal, message: error.message }, error.message);
      }
      firstUse = input.statements.use;
    }
    if (over === null) {
      const given = creationStatements(input.statements, { exports: exporting });
      if ('missing' in given) {
        return refused({ kind: 'missing_statement', missing: given.missing }, missingStatementRefusal(given.missing));
      }
      creating = given.statements;
      try {
        await checkCreation(saver, { teamId: input.teamId, statements: creating });
      } catch (error) {
        if (!(error instanceof StatementRefusedError)) throw error;
        return refused({ kind: 'statement', reason: error.refusal, message: error.message }, error.message);
      }
    }
    named = await timer.step('connections', () => connectionsNamed({ teamId: input.teamId, file: name, source: input.source }));
    const unusable = await unusableConnections(saver, named);
    if (unusable.length > 0) {
      const refusal = connectionsRefusal(unusable);
      return refused(refusal.refused, refusal.message);
    }
    const unusableLibs = await unusableLibraries(saver, await librariesNamed({ teamId: input.teamId, source: input.source }));
    if (unusableLibs.length > 0) {
      const refusal = librariesRefusal(unusableLibs);
      return refused(refusal.refused, refusal.message);
    }
  }

  const persist = (): Promise<MovementRow> =>
    writeMovementRow({
      teamId: input.teamId,
      intent,
      name,
      source: input.source,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.languageUpgrade !== undefined ? { languageVersion: input.languageUpgrade.to } : {}),
    });
  const statements = creating;
  // The automation and what it states commit together: a save never leaves
  // one with no statement, which would admit nobody. A run creating one is no
  // person choosing who may reach it.
  const stated = async (created: MovementRow): Promise<MovementRow> => {
    const target = { thing: 'automation', id: created.id } as const;
    if (saver === undefined) await stateRunCreation({ teamId: input.teamId, target, given: input.statements, exports: exporting });
    else if (statements !== undefined) await stateCreation(saver, { target, statements });
    else throw new Error('a person creating an automation reached the write with no statements decided');
    return created;
  };
  // An overwrite that adds the first export states the use list with the text.
  const statedFirstExport = async (overwritten: MovementRow): Promise<MovementRow> => {
    const target = { thing: 'automation', id: overwritten.id } as const;
    if (saver === undefined) await stateRunCreation({ teamId: input.teamId, target, given: undefined, exports: true, only: 'use' });
    else if (firstUse !== undefined) await setStatement(saver, { target, verb: 'use', grantees: firstUse });
    else throw new Error('a person adding a first export reached the write with no use list decided');
    return overwritten;
  };
  const creates = intent.kind === 'create';
  const addsFirstExport = !creates && exporting && over !== null && !(await hasUseList(input.teamId, over.id));
  let row: MovementRow;
  try {
    row = await timer.step('persist', () =>
      creates
        ? inOneTransaction(async () => stated(await persist()))
        : addsFirstExport
          ? inOneTransaction(async () => statedFirstExport(await persist()))
          : persist(),
    );
    // What it names may have changed, and with it whether its writers still hold what it reaches.
    if (exporting) await recomputeLibraryStanding(input.teamId, [row.id]);
  } catch (error) {
    // Between the checks above and the write, the name was taken or the row
    // deleted. Neither is repaired by writing something nobody decided.
    if (error instanceof MovementNameTakenError) return refused({ kind: 'name_taken', name }, nameTakenRefusal(name));
    if (error instanceof MovementGoneError) {
      return input.id !== undefined ? missing(input.id) : refused({ kind: 'name_gone', name }, nameGoneRefusal(name));
    }
    throw error;
  }
  const warned = async (): Promise<string[]> =>
    saver === undefined ? [] : accessWarnings({ teamId: input.teamId, automationId: row.id, named });

  // The source row is now saved — emit the resource-change hint here (the
  // shared service layer), so UI saves and agent saves both propagate
  // regardless of the save's eventual gate outcome below.
  onceCommitted(() =>
    emitMovementChange({
      teamId: input.teamId,
      movementId: row.id,
      action: 'saveMovement',
      ...(input.changeSource !== undefined ? { source: input.changeSource } : {}),
    }),
  );

  const { validation, validity, notes, gaps, teamCatalog } = await checkForSave({ input, row, timer });
  const sourceHash = movementSourceHash(input.source);

  // The acting user for journey milestones: a UI save threads it through
  // explicitly (`input.userId`); an agent/API-key save doesn't, but still
  // runs inside the authenticated request's context.
  const journeyContext = unsafeCurrentContext();
  const actingUserId =
    input.userId ?? (journeyContext?.authenticated ? journeyContext.user.id : undefined);
  // Monotonicity gate for the USER milestone only (see
  // `recordAutomationSavedMilestones` above) — did THIS request arrive via
  // MCP? Stamped on the Context by the auth middleware from `x-mcp-domain`.
  const viaMcp = journeyContext?.mcpDomain === 'automation';
  // An upgrade is nobody authoring an automation, so it counts as no milestone.
  const recordMilestones = (): void => {
    if (input.languageUpgrade !== undefined) return;
    onceCommitted(() => recordAutomationSavedMilestones({ actingUserId, teamId: input.teamId, viaMcp }));
  };

  // Record the validity axis once. Stamp consent when we're shipping a
  // non-`valid` movement on acknowledgement.
  const consented = validity.status !== 'valid' && input.acknowledgeErrors === true;
  await recordValidityOutcome({
    id: row.id,
    status: validity.status,
    reason: validity.reason,
    sourceHash,
    checkedAgainst: row.languageVersion,
    ...(consented ? { consentedAt: new Date() } : {}),
  });

  // The consent gate (decision 3b — no draft limbo, no last-live-keeps-running):
  // EVERY non-`valid` save without consent stops here as needsConfirmation. The
  // source is persisted (retained artifact) but what's RUNNING is unchanged
  // until the caller either repairs or consents. A consented save falls through
  // and genuinely REPLACES what's running — even broken (it then fires and
  // fails; the prediction rule + issues take it from there).
  if (validity.status !== 'valid' && !consented) {
    const gapErrors = gaps.map(
      (g) =>
        `couldn't verify this automation against "${g.adapter}" (${g.detail}) — its writes weren't checked`,
    );
    const diagnosticErrors = validation.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `${d.message} (line ${d.line}, col ${d.col})`);
    // `needsConfirmation` still counts: the source is durably persisted and
    // the user authored an automation — that's the milestone, independent
    // of whether it shipped live.
    recordMilestones();
    return {
      ok: false,
      needsConfirmation: true,
      validity,
      // Structured diagnostics ride validity.reason; these strings carry the
      // human summary (message + position) for surfaces that just print.
      errors: validity.status === 'unverified' ? gapErrors : diagnosticErrors,
      catalogNotes: notes,
      movementId: row.id,
    };
  }

  // Past the gate: the save SHIPS — it is now the movement that runs. Either
  // it's `valid`, or the caller consented to shipping it broken (decision 3b:
  // no draft limbo, no last-live-keeps-running). Reconcile listeners
  // best-effort: a consented-broken source may not compile far enough to
  // derive them, in which case the EXISTING trigger rows stay and now fire
  // this new source (which fails — fires-and-fails, by design).
  // A pin a carried version checks ships its text, and its listens are not
  // provisioned: this platform does not run that version, and says so.
  const carriedListening = teamCatalog === undefined ? listeningOf(row.languageVersion) : undefined;
  const provisioned: ProvisionMovementResult =
    carriedListening?.kind === 'carried'
      ? await provisionCarriedListeners({
          teamId: input.teamId as TeamId,
          audience: input.audience,
          movementRow: row,
          source: input.source,
          lane: await carriedListening.lane(),
          ...(input.languageUpgrade !== undefined ? { keepPauses: true } : {}),
          ...(consented ? { provisionDespiteErrors: true } : {}),
          ...(input.inTransaction !== undefined ? { providersLater: true } : {}),
          timer,
          notes,
        })
      : teamCatalog === undefined
      ? { ok: false, diagnostics: [notListenedDiagnostic(row.languageVersion)], catalogNotes: notes }
      : await timer.step('listeners', () => provisionListeners({
          teamId: input.teamId as TeamId,
          movementRow: row,
          source: input.source,
          teamCatalog,
          timer,
          ...(input.inTransaction !== undefined ? { providersLater: true } : {}),
          ...(input.languageUpgrade !== undefined ? { keepPauses: true } : {}),
          ...(input.languageUpgrade?.movedAt !== undefined ? { movedAt: input.languageUpgrade.movedAt } : {}),
          // A consented non-valid save ships: derive its declared listens despite
          // check errors so it genuinely fires-and-fails (decision 3b).
          ...(consented ? { provisionDespiteErrors: true } : {}),
        }));

  // Every shipped save is what runs — mint its immutable version (deduped by
  // content hash) so runs pin it and the version-match rule has its anchor.
  await timer.step('versionMint', () =>
    mintMovementVersionIfChanged({
      teamId: input.teamId,
      movementId: row.id,
      source: input.source,
      languageVersion: row.languageVersion,
    }),
  );

  // A carried version's save is its text and its check, under its own pin;
  // nothing of this release's listener reconciliation reads its text.
  if (teamCatalog === undefined) {
    recordMilestones();
    // The text is saved, under its pin, whether or not its version fires
    // listens yet: that is what a person is told, and not a failed save.
    if (!provisioned.ok && carriedListening?.kind === 'held') {
      return {
        ok: true,
        movementId: row.id,
        movementName: name,
        listeners: [],
        infos: [],
        catalogNotes: notes,
        warnings: [...(provisioned.diagnostics ?? []).map((diagnostic) => diagnostic.message), ...(await warned())],
        validity,
      };
    }
    if (!provisioned.ok) return { ...provisioned, movementId: row.id, validity };
    return { ...provisioned, warnings: [...provisioned.warnings, ...(await warned())], movementId: row.id, validity };
  }

  if (!provisioned.ok && validity.status === 'valid') {
    // A VALID program whose provisioning failed on infrastructure (config,
    // adapter resolution, …). Not a consent case — consent can't fix infra.
    // Surface the failure honestly. This DOES count as the authoring
    // milestone: the source is already durably persisted (upsertMovementRow,
    // above) and this branch's own guard proves it checked out `valid` — the
    // user did everything in their control. Only team-level infrastructure
    // stopped it shipping, which the user can't fix by authoring harder.
    // That failure is a distinct, later funnel step (first_run), not this one.
    recordMilestones();
    return { ...provisioned, movementId: row.id };
  }

  // Both remaining paths below ship the save (`ok: true`) — the definitive
  // success case.
  recordMilestones();

  const declaredNames = declaredMovementNames(input.source);
  const shippedWarnings = [
    ...(await timer.step('collisions', () =>
      movementNameCollisionWarnings({
        teamId: input.teamId,
        movementId: row.id,
        declaredNames: declaredNames ?? [],
      }),
    )),
    ...(await timer.step('accessWarnings', () => warned())),
  ];

  if (!provisioned.ok) {
    // The source didn't reach a listener set. Two very different reasons:
    if (declaredNames === null) {
      // UNPARSEABLE, and consented (a valid source can't be unparseable, and
      // an unconsented non-valid save never got here). The file declares no
      // listeners we can read, so the authoritative listener set is EMPTY:
      // retire every row through the same settle-then-delete path
      // reconciliation uses, and say so. Leaving the old rows firing text
      // that no longer parses is the silent disagreement decision 3b exists
      // to avoid — consent covers this consequence.
      await reconcileDerivedTriggers({
        teamId: input.teamId as TeamId,
        movementRow: row,
        desired: [],
        retirementReason:
          'This run was still waiting to continue when the automation was saved with a source that could not be read, so it was stopped.',
      });
      return {
        ok: true,
        movementId: row.id,
        movementName: name,
        listeners: [],
        infos: [],
        catalogNotes: notes,
        warnings: [
          'This source could not be read, so no listeners could be derived from it. You saved it anyway, so every listener this automation had has been retired — it will not fire again until a source that reads cleanly restores them.',
          ...shippedWarnings,
        ],
        validity,
      };
    }
    // PARSEABLE but provisioning failed on infrastructure (no dispatch config
    // for the team). Consent can't fix infra and the file's listens are still
    // legible, so the existing rows stay pointed at this movement and fire the
    // new source (which fails — fires-and-fails, by design).
    return {
      ok: true,
      movementId: row.id,
      movementName: name,
      listeners: [],
      infos: [],
      catalogNotes: [
        ...notes,
        'listeners could not be derived from this source — existing listeners (if any) keep firing it',
      ],
      warnings: shippedWarnings,
      validity,
    };
  }

  // Legacy convenience link: the first listener (or cleared when the file
  // declares none). The canonical relation is trigger.movement_id.
  const first = provisioned.listeners[0];
  await recordDerivedTriggerLink({
    id: row.id,
    triggerId: first?.triggerId ?? null,
  });
  return {
    ...provisioned,
    warnings: [...provisioned.warnings, ...shippedWarnings],
    movementId: row.id,
    validity,
  };
}

// ── Reading side: listeners projected per movement ──────────────────────────

export interface MovementListenerInfo {
  triggerId: string;
  /** `movement/<file>/<movement>`. */
  name: string;
  /** The channel — source adapter slug. */
  kind: string;
  config: Record<string, unknown>;
  configKey: string | null;
  /** `<local>+<key>@<domain>` for adapters with an inbound routing key, else null. */
  inboundAddress: string | null;
  /** The fired movement (the trigger-name convention's last segment). */
  movementName: string | null;
  /** Derived from the movement text on every save; not settable — see
   *  triggers/run_mode.ts. */
  runMode: TriggerRunMode;
  /** Why it runs nothing until a person resumes it (the loop breaker or the
   *  loop guard paused it); null while it runs. */
  paused: ListenPause | null;
}

function toListenerInfo(row: DerivedTriggerRow, pauses: ReadonlyMap<string, ListenPause>): MovementListenerInfo {
  const configKey = surfaceConfigKeyOf(row.config);
  // The fired movement is authoritative — an aliased listener's `name` is just
  // the alias (no `movement/<file>/<movement>` convention to parse), so deriving
  // the movement from the name string yields null and the editor can't match the
  // live row (it renders "Starts on save" on a listening trigger). Fall back to
  // the name convention only for legacy rows without a stored fired_movement_name.
  const nameParts = row.name.split('/');
  return {
    triggerId: row.id,
    name: row.name,
    kind: row.kind,
    config: row.config,
    configKey,
    inboundAddress: inboundAddressOf(row.config),
    movementName:
      row.firedMovementName ??
      (nameParts.length >= 3 ? nameParts[nameParts.length - 1] : null),
    runMode: row.runMode,
    paused: pauses.get(row.id) ?? null,
  };
}

export interface MovementListItem {
  id: string;
  name: string;
  /** Runtime validity of the current source (null = never checked) — NOT
   *  whether the file runs on its own. A library checks clean and is
   *  'valid' without anything ever invoking it; see `facets` for what the
   *  file actually is. */
  validityStatus: MovementValidityStatus | null;
  validityCheckedAt: Date | null;
  /** The language version the last validity check ran under. */
  validityCheckedAgainst: LanguageVersion | null;
  /** The language version the movement is written against (its pin). */
  languageVersion: LanguageVersion;
  /** What keeps it off the current language version — the errors and warnings
   *  validating it under that version found (pendingUpgradeDiagnostics). Null
   *  when it is on it, or nothing is recorded. */
  upgradeDiagnostics: AuthoringDiagnostic[] | null;
  /** First listener's channel (null for libraries). */
  kind: string | null;
  /** Derived listeners — one per `listen` statement of the last shipped save. */
  listeners: MovementListenerInfo[];
  /** The source declares a manual-channel listener — "Run now" works. */
  runnable: boolean;
  /** What the file IS, derived from its text: an automation (something
   *  invokes it), a library (others import it), or both. */
  facets: MovementFileFacets;
  createdAt: Date;
  updatedAt: Date;
}

/** Whether "Run now" has anything to invoke: a MANUAL-channel listener
 *  in the SOURCE — execution injects an invocation event on its derived
 *  trigger row (uniform dispatch). A pin a carried version runs is answered
 *  from the text's facets (the lexical scan any text gets), never by loading
 *  that version: a list of automations loads no version it has no work for,
 *  and the press itself is what its own parser answers. */
function isRunnable(row: MovementRow): boolean {
  if (runningOf(row.languageVersion).kind === 'carried') return movementFileFacets(row.source, row.languageVersion).runnableOnDemand;
  const route = routeOf(row.languageVersion);
  // A pin this platform does not run has nothing "Run now" can start.
  if (route.kind === 'refused' || route.kind === 'carried' || route.kind === 'dropped') return false;
  try {
    // A legacy pin's listens do not run under this release.
    if (route.kind === 'legacy') return false;
    const program = parseInstalled(row.source, { languageVersion: route.pin });
    return manualListenerMovements(program, { languageVersion: route.pin }).length > 0;
  } catch (e) {
    if (e instanceof MovementParseError) return false;
    throw e;
  }
}

export async function listMovements(teamId: string): Promise<MovementListItem[]> {
  const rows = await listMovementRows(teamId);
  const listenersByMovement = await listDerivedTriggerRowsForMovements(rows.map((r) => r.id));
  const pauses = await listenPauses({
    teamId: teamId as TeamId,
    triggerIds: [...listenersByMovement.values()].flat().map((l) => l.id),
  });
  return Promise.all(rows.map(async (row) => {
    const listeners = (listenersByMovement.get(row.id) ?? []).map((l) => toListenerInfo(l, pauses));
    return {
      id: row.id,
      name: row.name,
      validityStatus: row.validityStatus,
      validityCheckedAt: row.validityCheckedAt,
      validityCheckedAgainst: row.validityCheckedAgainst,
      languageVersion: row.languageVersion,
      upgradeDiagnostics: pendingUpgradeDiagnostics(row),
      kind: listeners[0]?.kind ?? null,
      listeners,
      runnable: isRunnable(row),
      facets: movementFileFacets(row.source, row.languageVersion),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }));
}

export interface MovementDetail extends MovementRow {
  /** Derived listeners — one per `listen` statement of the last shipped save. */
  listeners: MovementListenerInfo[];
  /** First listener's channel, kept for back-compat with the list shape. */
  kind: string | null;
  /** First listener's inbound address (adapters with an inbound routing key). */
  inboundAddress: string | null;
  /** The source declares a manual-channel listener — "Run now" works. */
  runnable: boolean;
  /** Content hash of the CURRENT `source` (`movementSourceHash`) — an
   *  optimistic-concurrency fingerprint. Pass it back as `expectedRevision` on
   *  a later `saveMovement` to guard against clobbering an edit made by
   *  someone (or something) else in the meantime; a mismatch there is refused
   *  as a conflict instead of silently overwriting. */
  revision: string;
}

export async function getMovement(input: {
  teamId: string;
  id: string;
}): Promise<MovementDetail | null> {
  const row = await getMovementRow(input);
  if (!row) return null;
  const derived = await listDerivedTriggerRows(row.id);
  const pauses = await listenPauses({ teamId: input.teamId as TeamId, triggerIds: derived.map((l) => l.id) });
  const listeners = derived.map((l) => toListenerInfo(l, pauses));
  return {
    ...row,
    // Only what still stands between it and the current version.
    upgradeDiagnostics: pendingUpgradeDiagnostics(row),
    listeners,
    kind: listeners[0]?.kind ?? null,
    inboundAddress: listeners[0]?.inboundAddress ?? null,
    runnable: isRunnable(row),
    revision: movementSourceHash(row.source),
  };
}

/**
 * Delete a movement and every row derived from it (the listener triggers,
 * plus any legacy compiled mappings still attached) — the text is
 * canonical, so removing it removes everything derived from it. Returns
 * false when the movement doesn't exist.
 */
/** Whether a file has a use list: it is a library. */
async function hasUseList(teamId: string, id: string): Promise<boolean> {
  return (await StatementStore.grantsOf({ thing: 'automation', id }, { teamId, verb: 'use' })).length > 0;
}

export async function deleteMovement(input: { teamId: string; id: string }): Promise<boolean> {
  const row = await getMovementRow(input);
  if (!row) return false;
  const qb = getAutomationsQb(['trigger']);

  const derived = [...(await listDerivedTriggerRows(row.id)), ...(await listLeftoverTriggerRows(row.id))];
  const triggerIds = new Set(derived.map((d) => d.id));
  if (row.triggerId !== null) triggerIds.add(row.triggerId); // legacy link
  // A Run now of a version this platform does not fire listens for has no
  // trigger row; its run is recorded under the movement's own id.
  const runTriggerIds = [...triggerIds, carriedRunTriggerId(row.id)];

  // Deleting the movement cascades its `movement_version` rows away, which
  // nulls `trigger_run.movement_version_id` on every run parked against these
  // triggers — leaving them permanently unresumable. Settle them FIRST, while
  // the pin still resolves and we can still say why the work stopped.
  await settleRunsParkedOnTriggers({
    triggerIds: runTriggerIds,
    reason:
      'This run was still waiting to continue when the automation was deleted, so it was stopped.',
  });

  // A RUNNING run isn't parked, so the settle above doesn't reach it, but its
  // callbacks are just as unfireable once the version pin is gone (a fire has no
  // program to resume into). Revoke every callback of every run of these
  // triggers, so a late tap gets the closed answer rather than a router error.
  await revokeCallbacksOfTriggers(runTriggerIds);

  for (const triggerId of triggerIds) {
    await qb
      .deleteFrom('trigger')
      .where('id', '=', triggerId as TriggerId)
      .execute();
  }
  // The automation and what is stated about it go together.
  await inOneTransaction(async () => {
    await deleteMovementRow(input);
    await StatementStore.deleteStatementsOf({ thing: 'automation', id: input.id }, { teamId: input.teamId });
  });
  // Retiring the file's listeners may have emptied an (adapter,
  // credential) channel — tear its external subscription down too.
  await syncListenSubscriptions({ teamId: input.teamId as TeamId });
  emitMovementChange({ teamId: input.teamId, movementId: input.id, action: 'deleteMovement' });
  return true;
}

/** Revoke every callback minted by any run of these triggers (movement delete).
 *  Scoped by run so it is one indexed read plus one update: the callback table
 *  keys on the run, never on the trigger. */
async function revokeCallbacksOfTriggers(triggerIds: readonly string[]): Promise<void> {
  const runs = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('trigger_id', 'in', [...triggerIds]).select('id').execute();
  await revokeCallbacksForRuns(runs.map((run) => run.id));
}

/** The first movement declaration's name. Uses the real parser (the installed
 *  one, whatever the pin: a name reader, not a verdict) — the AST name
 *  is grammar-correct by construction (backtick or bare). Only an *unparseable*
 *  draft falls back to a best-effort scan, which reads the name with the
 *  parser's own `scanName`, so the name grammar lives in exactly one place. */
export function movementNameFromSource(source: string): string | undefined {
  try {
    return parseInstalled(source).statements.find(
      (s): s is MovementDeclaration => s.kind === 'movement',
    )?.name;
  } catch {
    // Unparseable draft: locate the first `movement` keyword and read the name
    // with the parser's primitive (never a bespoke name regex — that drifts).
    const keyword = /(?:^|\n)[^\S\n]*movement[^\S\n]+/.exec(source);
    if (keyword === null) return undefined;
    return scanName(source, keyword.index + keyword[0].length)?.name;
  }
}
