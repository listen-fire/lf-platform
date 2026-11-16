// A carried version's listens, as the platform's listen upkeep reads them: the
// trigger rows pinned to a version whose listens fire through its own lane,
// each with how that version says it is watched (`watchOf`, its own plan
// schema; the platform never reads a carried plan). Polls, subscriptions and
// member listings share these by key exactly as they share the current
// version's (listen_edge.ts), each key naming its version, so one version's
// module never polls or subscribes for another's listens.

import { carriedVersions, versionOf, type CarriedVersion, type ListenRow, type ListenWatch, type ListeningLane } from '@listen-fire/language-versions';
import { logger } from 'movement-engine/public/log';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../generated/kysely/automations/Movement';
import type { Resolution } from '../lf_store/listens';

import { getAutomationsQb } from '../../lib/kysely';
import { teamIdSchema } from '../../lib/team_id';
import { triggerIdSchema } from '../../lib/trigger_id';
import { parseRunMode, type TriggerRunMode } from '../translation_graph/triggers/run_mode';
import { states } from '../lf_store/listens';
import { siblingKindsForAdapter } from '../translation_graph/adapters/registry';
import { edgeKeysOf, pollsAloneOf, type ListenDelivery, type WatchedListen } from './listen_edge';

/** One trigger row a carried version reads as its listen. */
export interface CarriedListen {
  version: CarriedVersion;
  lane: ListeningLane;
  /** The row as the version reads it, with the text its automation shipped. */
  row: ListenRow;
  watch: ListenWatch;
  triggerId: TriggerId;
  teamId: TeamId;
  /** The file (the movement row's name) the listen is in. */
  file: string;
  credentialsId: string | null;
  /** Whether its runs go live, rehearse or are paused. */
  runMode: TriggerRunMode;
  /** The version its automation shipped, which a run started on purpose pins. */
  versionId: string;
  /** What its last member listing came to, for a listen the host lists the
   *  members of; absent for one never listed, and for any other. */
  watching?: Resolution;
}

/** The kinds a listen on this module may be filed under. */
export function kindsOf(origin: { adapterType: string; providerKey?: string }): string[] {
  return [...new Set([origin.adapterType, ...(origin.providerKey !== undefined ? [origin.providerKey] : []), ...siblingKindsForAdapter(origin.adapterType)])];
}

/** Which trigger rows a read is of: a team's (on these kinds), or one row. */
interface RowsWanted {
  teamId?: TeamId;
  kinds?: readonly string[];
  triggerId?: TriggerId;
  /** One automation's rows. */
  movementId?: MovementId;
  /** Only rows that fire: a paused row is not polled. */
  firing?: boolean;
}

function rowsQuery(input: RowsWanted) {
  let query = getAutomationsQb(['trigger', 'movement', 'movement_version'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .innerJoin('movement_version', 'movement_version.id', 'movement.current_version_id');
  if (input.teamId !== undefined) query = query.where('trigger.team_id', '=', input.teamId);
  if (input.kinds !== undefined) query = query.where('trigger.kind', 'in', [...input.kinds]);
  if (input.triggerId !== undefined) query = query.where('trigger.id', '=', input.triggerId);
  if (input.movementId !== undefined) query = query.where('trigger.movement_id', '=', input.movementId);
  if (input.firing === true) query = query.where('trigger.run_mode', '!=', 'off');
  return query;
}

/** Whether a version's listens fire through its own lane. */
function listensCarried(version: CarriedVersion): boolean {
  return version.provides.listen.kind === 'carried' && version.listenRows !== undefined;
}

/** The carried version a pin's rows are read by, when its listens fire through
 *  its own lane. */
export function listeningVersionOf(pin: string): CarriedVersion | undefined {
  const version = versionOf(pin);
  return version !== undefined && listensCarried(version) ? version : undefined;
}

/** The pins among the rows wanted that a carried version reads (of `version`
 *  only, when named), each with its version: one small read, so a read of
 *  only current rows reads no config. */
async function listeningPins(input: RowsWanted & { version?: string }): Promise<Map<string, CarriedVersion>> {
  const pins = await rowsQuery(input).select('movement_version.language_version as pin').distinct().execute();
  const listening = new Map<string, CarriedVersion>();
  for (const { pin } of pins) {
    const version = listeningVersionOf(pin);
    if (version !== undefined && (input.version === undefined || version.key === input.version)) listening.set(pin, version);
  }
  return listening;
}

/** A row on a carried pin, with what the platform keeps beside its plan. */
type ShippedRow = ListenRow & { teamId: TeamId; file: string; runMode: TriggerRunMode; versionId: string };

/** The rows wanted on these pins, each with the pin it ships under. */
async function shippedListenRows(input: RowsWanted & { pins: readonly string[] }): Promise<Array<ShippedRow>> {
  const rows = await rowsQuery(input)
    .where('movement_version.language_version', 'in', [...input.pins])
    .select([
      'trigger.id as id',
      'trigger.team_id as teamId',
      'trigger.kind as kind',
      'trigger.credentials_id as credentialsId',
      'trigger.config as config',
      'trigger.fired_movement_name as firedMovementName',
      'movement.name as file',
      'movement_version.language_version as pin',
      'trigger.run_mode as runMode',
      'movement_version.id as versionId',
    ])
    .execute();
  return rows.map((row) => ({ ...row, teamId: teamIdSchema.parse(row.teamId), credentialsId: row.credentialsId ?? null, runMode: parseRunMode(row.runMode) }));
}

/** Whether any of `kinds` holds a row pinned to a carried version that listens:
 *  a door asks no version to judge a page none of its listens is on. */
export async function anyCarriedPin(input: { teamId: TeamId; kinds: readonly string[] }): Promise<boolean> {
  return (await listeningPins(input)).size > 0;
}

/** The kinds the team's rows pinned to these versions are filed under: what a
 *  version whose listens could not be read has on which modules, read without
 *  their plans. */
export async function kindsPinnedTo(input: { teamId: TeamId; versions: ReadonlySet<string> }): Promise<Set<string>> {
  if (input.versions.size === 0) return new Set();
  const rows = await rowsQuery({ teamId: input.teamId }).select(['trigger.kind as kind', 'movement_version.language_version as pin']).distinct().execute();
  return new Set(rows.flatMap(({ kind, pin }) => {
    const key = versionOf(pin)?.key;
    return key !== undefined && input.versions.has(key) ? [kind] : [];
  }));
}

/** `listens` with what each listed listen's last listing came to. */
async function withWatching(listens: CarriedListen[]): Promise<CarriedListen[]> {
  const byTeam = new Map<TeamId, string[]>();
  for (const listen of listens) {
    if (!listen.watch.traversals.some((traversal) => traversal.resolves)) continue;
    byTeam.set(listen.teamId, [...(byTeam.get(listen.teamId) ?? []), listen.watch.pipeline]);
  }
  if (byTeam.size === 0) return listens;
  const kept = new Map<string, Resolution>();
  for (const [teamId, pipelines] of byTeam) {
    for (const [pipeline, state] of Object.entries(await states({ tenant: teamId }, { pipelines }))) {
      kept.set(`${teamId}:${pipeline}`, {
        heads: state.heads,
        resolvedAt: state.resolvedAt,
        failure: state.failure,
        ...(state.parents !== undefined ? { parents: state.parents } : {}),
        ...(state.members !== undefined ? { members: state.members } : {}),
      });
    }
  }
  return listens.map((listen) => {
    const watching = kept.get(`${listen.teamId}:${listen.watch.pipeline}`);
    return watching !== undefined ? { ...listen, watching } : listen;
  });
}

/** One version's rows as its listens, read with its own lane. */
async function listensOfVersion(version: CarriedVersion, rows: readonly ShippedRow[]): Promise<CarriedListen[]> {
  const load = version.listenRows;
  if (load === undefined) return [];
  const lane = await load();
  return rows.flatMap(({ teamId, file, runMode, versionId, ...row }) => {
    const watch = lane.watchOf(row);
    return watch === null ? [] : [{ version, lane, row, watch, triggerId: triggerIdSchema.parse(row.id), teamId, file, credentialsId: row.credentialsId, runMode, versionId }];
  });
}

/** What a read of carried listens came to: the listens, and the versions whose
 *  listens could not be read (their lane did not load, or their rows could not
 *  be read), which a caller that carries on without them must not take for
 *  versions with no listens. */
export interface CarriedRead {
  listens: CarriedListen[];
  unread: ReadonlySet<string>;
}

/** The versions a failed read leaves unread: every one that listens, or the
 *  one named. */
function everyListeningKey(version: string | undefined): Set<string> {
  return new Set(carriedVersions().flatMap((candidate) => (listensCarried(candidate) && (version === undefined || candidate.key === version) ? [candidate.key] : [])));
}

/** The rows wanted that a carried version reads as its listens, each with how
 *  it says it is watched. One lane load per version. `contained`: a version
 *  whose listens cannot be read is left out and named (`unread`), so the
 *  current version's upkeep beside it never stops for it; otherwise the
 *  failure throws. */
async function readCarriedListens(input: RowsWanted & { version?: string }, options: { contained: boolean }): Promise<CarriedRead> {
  const unread = new Set<string>();
  const failed = (keys: Iterable<string>, error: unknown): void => {
    if (!options.contained) throw error;
    for (const key of keys) unread.add(key);
    logger.error('[CarriedListens] a carried version\'s listens could not be read: its upkeep is skipped this time', {
      versions: [...keys],
      error: error instanceof Error ? error.message : String(error),
    });
  };
  let byVersion: Map<string, { version: CarriedVersion; rows: ShippedRow[] }>;
  try {
    const pins = await listeningPins(input);
    if (pins.size === 0) return { listens: [], unread };
    byVersion = new Map();
    for (const row of await shippedListenRows({ ...input, pins: [...pins.keys()] })) {
      const version = pins.get(row.pin);
      if (version === undefined) continue;
      const held = byVersion.get(version.key) ?? { version, rows: [] };
      held.rows.push(row);
      byVersion.set(version.key, held);
    }
  } catch (error) {
    failed(everyListeningKey(input.version), error);
    return { listens: [], unread };
  }
  const listens: CarriedListen[] = [];
  for (const [key, { version, rows }] of byVersion) {
    try {
      listens.push(...(await listensOfVersion(version, rows)));
    } catch (error) {
      failed([key], error);
    }
  }
  try {
    return { listens: await withWatching(listens), unread };
  } catch (error) {
    failed(byVersion.keys(), error);
    return { listens: [], unread };
  }
}

/** The rows wanted that a carried version reads as its listens; a failure to
 *  read them throws. */
export async function carriedListens(input: RowsWanted & { version?: string }): Promise<CarriedListen[]> {
  return (await readCarriedListens(input, { contained: false })).listens;
}

/** The carried listens the current version's upkeep reads beside its own: a
 *  version whose listens cannot be read is logged and named, never thrown. */
export async function carriedListensContained(input: RowsWanted): Promise<CarriedRead> {
  return readCarriedListens(input, { contained: true });
}

/** One carried listen as its keys are made: each traversal watched under the
 *  records its last listing came to, its own or its member's, and polled alone
 *  when it brought its own cursor, as a current listen's keys are: dropping its
 *  version names the key it polled under while its version was current. */
export function carriedWatched(listen: CarriedListen): WatchedListen {
  return {
    teamId: listen.teamId,
    triggerId: listen.triggerId,
    adapter: listen.watch.adapter,
    credentialsId: listen.credentialsId,
    constructionArgs: listen.watch.constructionArgs,
    traversals: listen.watch.traversals.map((traversal) => ({
      edge: traversal.edge,
      taken: traversal.taken,
      delivery: traversal.delivery,
      scopes: traversal.member === undefined ? listen.watching?.heads : listen.watching?.members?.[traversal.member]?.heads,
    })),
    ...(pollsAloneOf(listen.row.config) ? { pollsAlone: true } : {}),
    version: listen.version.key,
  };
}

/** The keys a carried listen is delivered under (`edgeKeysOf`). */
export function carriedEdgeKeysOf(listen: CarriedListen, deliveries: readonly ListenDelivery[]): ReturnType<typeof edgeKeysOf> {
  return edgeKeysOf(carriedWatched(listen), deliveries);
}
