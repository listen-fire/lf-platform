// A segment someone started, run by a carried version's own engine and
// modules (`@listen-fire/language-versions`, its `run` capability). The
// platform hands the version the services every version shares (one
// `RunPlatform`): its billed model calls and file text, its record bindings,
// its cross-run write locks, its write ledger, its acting-user rules, its
// cancel and lease, and the hosting of each module install (the stored
// credential, refreshed under the platform's one lock). The version answers
// with plain data, which this file turns back into this release's own
// outcomes: a failure as this release's `MovementRunFailed`, a lost lease as
// this release's `RunLeaseLost`, so the firing's recorder settles a carried
// run exactly as it settles one of this release's.

import { z } from 'zod';
import { WireActorCandidate } from 'engine-contracts';
import { MovementEngineError, MovementRunFailed, type MovementEngineErrorCode } from 'movement-engine/public/errors';
import { logger } from 'movement-engine/public/log';
import { inProcessValidationDefault } from 'module-kit';
import {
  runningOf,
  type CarriedEvent,
  type CarriedParks,
  type ModulePlatform,
  type ResumeRequest,
  type ResumingLane,
  type RunPlatform,
  type RunningLane,
  type SegmentOutcome,
  type TeamFacts,
} from '@listen-fire/language-versions';

import type { LanguageVersion } from 'movement-lang';
import type { Adapter, DryRunWriteSink } from 'movement-engine/public/adapter';
import type { MovementRunResult } from 'movement-engine/public/movement-engine';
import type { MovementTraceEntry } from 'movement-engine/public/trace';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { DbCancelGate } from '../../movement_engine/cancel_gate';

import type { TriggerRunRecorder } from '../runs/trigger_run';

import { callbackUrl } from '../../movement_engine/callback_store';
import { carriedRunHost } from '../../movement_engine/carried_host';
import { markRunLimitPaused } from '../../movement_engine/limit_pause';
import { notifyWork } from '../../work/drain';
import { recordRunEngineOnRow } from '../../movement_engine/run_engine_record';
import { RunLeaseLost } from '../../movement_engine/run_lease';
import { teamCredentials } from '../../credentials/credential_ownership';
import { runWriteKeeper } from '../../movement_engine/run_writes';
import { askUrl } from '../../asks/store';
import { mutationDelivery } from '../../knowledge/mutation_outbox/delivery_mode';
import { moduleHostFor } from '../adapters/builtin_modules';
import { remoteInstallPieces } from '../adapters/resolve';
import { platformKgStore } from '../adapters/kg_store';
import { carriedSystemRecords } from '../adapters/system/carried_records';
import { platformSlackChat, platformSlackFile } from '../adapters/slack/platform';
import { WHATSAPP_MOVEMENTS_NUMBER } from '../adapters/whatsapp/shared_app';
import { resolveActingUser } from '../adapters/acting_user/resolve';
import { isExposedFileUrl } from '../engine/files/expose';
import { streamFileRef, withFileOwners } from '../engine/files/retrieve';
import { teamIdSchema } from '../../../lib/team_id';
import { loadActingUserTrigger, sharedRunServices } from './engine_host';
import { teamFactsOf } from './carried_check';

/** The carried run host `pin`'s version provides, or undefined when this
 *  release runs `pin` itself or does not run it. */
export async function carriedRunLaneOf(pin: LanguageVersion): Promise<RunningLane | undefined> {
  const running = runningOf(pin);
  return running.kind === 'carried' ? running.lane() : undefined;
}

const actorCandidates = z.array(WireActorCandidate);

/** How the platform hosts a carried version's modules: each install as it
 *  hosts its own release's module for the same adapter type, and the parts
 *  its own modules are defined with. A check reads connected systems through
 *  it too. */
export function modulePlatform(): ModulePlatform {
  return {
    hostFor: ({ adapterType, install, declaration }) =>
      moduleHostFor({ adapterType, install: { ...install, teamId: teamIdSchema.parse(install.teamId) }, declaration }),
    parts: {
      askAnswerUrl: askUrl,
      kgStore: (install) => platformKgStore({ teamId: teamIdSchema.parse(install.teamId), credentialsId: install.credentialsId }),
      kgChangeWebhooks: mutationDelivery() === 'webhook',
      slackChat: platformSlackChat,
      readFile: (ref, teamId) => platformSlackFile(ref, teamIdSchema.parse(teamId)),
      whatsappNumber: WHATSAPP_MOVEMENTS_NUMBER,
      isExposedFileUrl,
      readDocument: (ref, { teamId }) => streamFileRef(ref, { teamId: teamIdSchema.parse(teamId) }),
      systemRecords: carriedSystemRecords,
      remoteInstall: ({ adapterType, teamId, credentialsId }) =>
        remoteInstallPieces({ adapterType, teamId: teamIdSchema.parse(teamId), ...(credentialsId !== undefined ? { credentialsId } : {}) }),
    },
    log: logger,
    validateResults: inProcessValidationDefault(process.env),
  };
}

/** The platform's services, for one run of a carried version. */
export function runPlatformFor(input: {
  teamId: TeamId;
  /** The run its model calls are billed to and its writes are kept under;
   *  absent for a test run, which bills nothing and sends nothing. */
  triggerRunId?: TriggerRunId;
  cancel: DbCancelGate;
  lease?: { isLost(): boolean };
  writeSink?: DryRunWriteSink;
  parks?: CarriedParks;
}): RunPlatform {
  const shared = sharedRunServices({
    teamId: input.teamId,
    ...(input.triggerRunId !== undefined ? { triggerRunId: input.triggerRunId } : {}),
    cancel: input.cancel,
    // A pin's meaning does not change within its compatibility key. A run
    // pinned to a carried release skips an image: reading one would spend its
    // budget and change its answers. And a read past its budget reads as an
    // unreadable file and the run goes on, where a current run stops at the
    // cap. Upgrading the pin is how it gets both.
    asCarriedRelease: true,
  });
  const keep = input.triggerRunId !== undefined ? runWriteKeeper({ teamId: input.teamId, runId: input.triggerRunId }) : undefined;
  return {
    modules: modulePlatform(),
    recordEngine: recordRunEngineOnRow,
    credentials: teamCredentials,
    llm: shared.llm,
    files: { resolveFileText: shared.resolveFileText, render: shared.render },
    // A carried release's instance is not this release's `Adapter`. The byte
    // reader asks one thing of an owner, `resolveFileRef`, and asks whether it
    // has it (`redeemFileRef`), so the instance serves as that owner.
    withFileOwners: (owners, call) => withFileOwners((owner) => owners(owner) as Adapter | undefined, call),
    bindings: shared.bindings,
    locks: shared.locks,
    actingUser: async ({ teamId, triggerId, candidates }) => {
      const trigger = triggerId !== undefined ? await loadActingUserTrigger(triggerId) : undefined;
      return resolveActingUser({
        teamId: teamIdSchema.parse(teamId),
        ...(trigger !== undefined ? { trigger } : {}),
        // A carried module's candidates, checked against this release's
        // protocol shape rather than trusted.
        getCandidates: async () => actorCandidates.parse(await candidates()),
      });
    },
    // The gate's own lease check throws this release's `RunLeaseLost`, which a
    // carried engine would read as an ordinary failure: the version asks
    // `leaseLost` first and throws its own class, so here a lost lease is only
    // an answer.
    control: {
      cancelled: () => withoutLeaseThrow(() => input.cancel.cancelled()),
      cancelledNow: () => withoutLeaseThrow(() => input.cancel.cancelledNow()),
      leaseLost: () => input.lease?.isLost() ?? false,
    },
    ...(keep !== undefined ? { keepWrite: keep } : {}),
    ...(input.writeSink !== undefined ? { writeSink: input.writeSink } : {}),
    ...(input.parks !== undefined ? { parks: input.parks } : {}),
  };
}

/** Where one segment's parks and callbacks go: through its recorder, so the run
 *  row is there first and shows parked, under the lease it holds. */
export function carriedParksOf(recorder: TriggerRunRecorder, lease?: { token: string }): CarriedParks {
  return {
    host: carriedRunHost(),
    ...(lease !== undefined ? { fence: lease.token } : {}),
    ensureRun: () => recorder.ensureStarted(),
    markParked: () => recorder.markParked(),
    markLimitPaused: (pause) => markRunLimitPaused({ runId: recorder.triggerRunId, teamId: recorder.teamId, triggerId: recorder.triggerId, pause }),
    callbackUrl,
    notifyWork,
  };
}

async function withoutLeaseThrow(ask: () => Promise<boolean>): Promise<boolean> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof RunLeaseLost) return false;
    throw error;
  }
}

/** Every error code this release has: a `Record` over the code type, so a
 *  code added to this release must be listed here before it compiles. */
const CURRENT_CODES: Record<MovementEngineErrorCode, true> = {
  MOVENG_PARSE: true,
  MOVENG_CHECK: true,
  MOVENG_LANGUAGE_VERSION: true,
  MOVENG_NOT_FOUND: true,
  MOVENG_UNSUPPORTED: true,
  MOVENG_RUNTIME: true,
  MOVENG_CALL_DEPTH: true,
  MOVENG_PARK_NONSERIALIZABLE: true,
  MOVENG_ERROR: true,
  MOVENG_LIMIT_STEPS: true,
  MOVENG_LIMIT_TEXT_SIZE: true,
  MOVENG_LIMIT_COLLECTION_SIZE: true,
  MOVENG_LIMIT_RESULT_SIZE: true,
  MOVENG_LIMIT_WALL_CLOCK: true,
};

function isCurrentCode(code: string): code is MovementEngineErrorCode {
  return Object.hasOwn(CURRENT_CODES, code);
}

/** This release's error code for a carried version's code, when this release
 *  has the same one: a code is compared, never parsed. */
function currentCodeOf(code: string | undefined): MovementEngineErrorCode | undefined {
  return code !== undefined && isCurrentCode(code) ? code : undefined;
}

const EMPTY_RESULT: (movementName: string) => MovementRunResult = (movementName) => ({
  movementName,
  writes: [],
  extractionSites: {},
  trace: [],
});

/** A carried segment's outcome as this release's: its result, or a throw of
 *  this release's own classes, which the firing settles as it settles any. */
export function settledOutcome(outcome: SegmentOutcome, context: { runId: string; movementName: string }): MovementRunResult {
  switch (outcome.kind) {
    case 'ran':
      return outcome.result;
    case 'lease-lost':
      throw new RunLeaseLost(context.runId);
    case 'failed': {
      const code = currentCodeOf(outcome.code);
      // `message` is the carried version's own description, code included.
      const cause = code !== undefined ? new MovementEngineError(code, stripCode(outcome.message, code)) : new Error(outcome.message);
      throw new MovementRunFailed(cause, outcome.partial ?? EMPTY_RESULT(context.movementName));
    }
    default: {
      const unknown: never = outcome;
      throw new Error(`unknown segment outcome ${JSON.stringify(unknown)}`);
    }
  }
}

/** The carried description without its leading code, so this release's error
 *  does not say the code twice. */
function stripCode(message: string, code: string): string {
  const prefix = `${code}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/**
 * Runs one segment of `source` under its carried `pin` from its first
 * statement, against the team's files on the same version (their shipped text
 * for a firing, their live text for a test run), and answers its result as
 * this release reads one. Its parks go through `parks`; a rehearsal has none,
 * and never parks.
 */
export async function runCarriedSegment(input: {
  lane: RunningLane;
  teamId: TeamId;
  source: string;
  pin: LanguageVersion;
  movementName?: string;
  event: CarriedEvent;
  firedAt: Date;
  /** Absent for a test run. */
  triggerRunId?: TriggerRunId;
  imports: 'shipped' | 'live';
  cancel: DbCancelGate;
  lease?: { isLost(): boolean };
  trace?: MovementTraceEntry[];
  dryRun?: boolean;
  writeSink?: DryRunWriteSink;
  costCapMicrodollars?: number;
  team?: TeamFacts;
  parks?: CarriedParks;
}): Promise<MovementRunResult> {
  const team = input.team ?? (await teamFactsOf(input.teamId, { imports: input.imports }));
  const outcome = await input.lane.runSegment(
    {
      source: input.source,
      pin: input.pin,
      ...(input.movementName !== undefined ? { movementName: input.movementName } : {}),
      event: input.event,
      teamId: input.teamId,
      firedAt: input.firedAt.toISOString(),
      ...(input.triggerRunId !== undefined ? { runId: input.triggerRunId } : {}),
      ...(input.costCapMicrodollars !== undefined ? { costCapMicrodollars: input.costCapMicrodollars } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      team,
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
    },
    runPlatformFor({
      teamId: input.teamId,
      ...(input.triggerRunId !== undefined ? { triggerRunId: input.triggerRunId } : {}),
      cancel: input.cancel,
      ...(input.lease !== undefined ? { lease: input.lease } : {}),
      ...(input.writeSink !== undefined ? { writeSink: input.writeSink } : {}),
      ...(input.parks !== undefined ? { parks: input.parks } : {}),
    }),
  );
  return settledOutcome(outcome, { runId: input.triggerRunId ?? 'a test run', movementName: input.movementName ?? '' });
}

/** One segment of a run a carried version parked, on that version's engine, from
 *  the pinned text and the version's own event and state. */
export async function resumeCarriedSegment(input: {
  lane: ResumingLane;
  request: Omit<ResumeRequest, 'team'>;
  teamId: TeamId;
  triggerRunId: TriggerRunId;
  cancel: DbCancelGate;
  lease?: { isLost(): boolean };
  parks: CarriedParks;
}): Promise<MovementRunResult> {
  const team = await teamFactsOf(input.teamId, { imports: 'shipped' });
  const outcome = await input.lane.resumeSegment(
    { ...input.request, team },
    runPlatformFor({
      teamId: input.teamId,
      triggerRunId: input.triggerRunId,
      cancel: input.cancel,
      ...(input.lease !== undefined ? { lease: input.lease } : {}),
      parks: input.parks,
    }),
  );
  return settledOutcome(outcome, { runId: input.triggerRunId, movementName: input.request.movementName ?? '' });
}
