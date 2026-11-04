// Trigger-row lookups.
//
// A `automations.trigger` row is purely the dispatch index for a movement's
// `listen` statement: its `kind` (adapter slug), `config` (routing key /
// mutation filter / event types), optional `credentials_id`, and its
// `movement_id` (the movement whose text executes when it fires). The row
// carries no orchestration / object code — execution reads the canonical
// movement text (services/movement_engine/run.ts).
//
// These helpers are the read surface dispatch uses: resolve a trigger by id
// (inbound + mutation router), find the trigger owning an inbound key, find
// every trigger of a kind (webhook fan-out + KG_MUTATION dispatch), and the
// uniqueness lookup for adapter-declared `unique` config fields.

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb } from '../../../lib/kysely';
import { listeningOf } from '@listen-fire/language-versions';
import { parseRunMode, type TriggerRunMode } from '../triggers/run_mode';
import { resolveAdapterSlug, siblingKindsForAdapter } from '../adapters/registry';
import { inboxKeysOf } from '../adapters/email/listen_keys';
import { listenConfigSchema } from '../../inbound/listen_door';

/**
 * Load one `trigger` row by id. Returns null when missing. Dispatchers
 * call this when they need the adapter slug / config / credentials.
 */
export async function loadTriggerById(triggerId: string): Promise<{
  id: string;
  teamId: string;
  name: string;
  kind: string;
  config: unknown;
  credentialsId: string | null;
  /** The movement whose `listen` derives this trigger — null for legacy /
   *  orphaned rows. Dispatch routes to the movement engine off this. */
  movementId: string | null;
  /** The movement the `listen … fire <name>` clause runs — handed to the
   *  engine to pick the movement in a multi-movement file. Null = legacy /
   *  single-movement (the engine then requires exactly one declaration). */
  firedMovementName: string | null;
  createdByUserId: string | null;
  runMode: TriggerRunMode;
} | null> {
  const row = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', '=', triggerId as TriggerId)
    .select([
      'id',
      'team_id',
      'name',
      'kind',
      'config',
      'credentials_id',
      'movement_id',
      'fired_movement_name',
      'created_by_user_id',
      'run_mode',
    ])
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    teamId: row.team_id as unknown as string,
    name: row.name,
    kind: row.kind,
    config: row.config,
    credentialsId: (row.credentials_id as unknown as string) ?? null,
    movementId: (row.movement_id as unknown as string) ?? null,
    firedMovementName: (row.fired_movement_name as unknown as string) ?? null,
    createdByUserId: (row.created_by_user_id as unknown as string) ?? null,
    runMode: parseRunMode(row.run_mode),
  };
}

/**
 * The listen of `teamId` on the shared inbox that names `key` (its WHERE
 * requires `Key` to be it; ruling 5), or null. Keys are lowercase, as the door
 * reads a plus-suffix, so a public inbox's claim (case-insensitive) and the
 * listen it opens meet whatever their spelling.
 *
 * Model A tolerance (mirrors `findTriggersByKind`): `trigger.kind` is the
 * adapter slug ('email') on newly-provisioned rows, while inbound callers
 * still key on legacy channel kinds ('CUSTOM_EMAIL', 'MAILGUN'). Expand each
 * requested kind to its canonical slug + sibling kinds so both resolve.
 */
function inboxKeyOfCarriedRow(config: unknown): string | undefined {
  const key = typeof config === 'object' && config !== null && 'key' in config ? config.key : undefined;
  return typeof key === 'string' ? key.toLowerCase() : undefined;
}

export async function findTriggerByInboundKey(input: {
  teamId: string;
  kinds: string[];
  key: string;
}): Promise<{ id: string; kind: string; credentialsId: string | null } | null> {
  if (input.kinds.length === 0) return null;
  const expanded = Array.from(
    new Set(
      input.kinds.flatMap((k) => [
        k,
        resolveAdapterSlug(k),
        ...siblingKindsForAdapter(k),
      ]),
    ),
  );
  const rows = await getAutomationsQb(['trigger', 'movement'])
    .selectFrom('trigger')
    .leftJoin('movement', 'movement.id', 'trigger.movement_id')
    .where('trigger.team_id', '=', input.teamId as TeamId)
    .where('trigger.kind', 'in', expanded)
    .select(['trigger.id as id', 'trigger.kind as kind', 'trigger.credentials_id as credentials_id', 'trigger.config as config', 'movement.language_version as pin'])
    .execute();
  const key = input.key.toLowerCase();
  const row = rows.find((candidate) => {
    const listen = listenConfigSchema.safeParse(candidate.config);
    if (listen.success) return inboxKeysOf(listen.data.listen.plan, listen.data.listen.fieldIds).includes(key);
    // A carried version's listen keeps its key in its config, as production
    // read it, compared the way a public inbox's claim is.
    return candidate.pin !== null && listeningOf(candidate.pin).kind === 'carried' && inboxKeyOfCarriedRow(candidate.config) === key;
  });
  if (!row) return null;
  return {
    id: row.id as unknown as string,
    kind: row.kind,
    credentialsId: (row.credentials_id as unknown as string) ?? null,
  };
}

/**
 * Webhook / mutation-side dispatch lookup: find every trigger on a team
 * whose `kind` is in the given set. Used by the webhook handler (to
 * fan out provider-keyed triggers) and the mutation dispatcher (to find
 * `KG_MUTATION` triggers). Caller layers any further filtering on top.
 */
export async function findTriggersByKind(input: {
  teamId: string;
  kinds: string[];
}): Promise<
  Array<{
    id: string;
    name: string;
    kind: string;
    config: unknown;
    credentialsId: string | null;
    runMode: TriggerRunMode;
    /** Set on movement-derived rows — dispatch executes the canonical
     *  text via `runMovementFiring`. */
    movementId: string | null;
    /** The movement the `listen … fire <name>` clause runs — handed to the
     *  engine to pick the movement in a multi-movement file. */
    firedMovementName: string | null;
  }>
> {
  if (input.kinds.length === 0) return [];
  const expanded = Array.from(
    new Set(
      input.kinds.flatMap((k) => [
        k,
        resolveAdapterSlug(k),
        ...siblingKindsForAdapter(k),
      ]),
    ),
  );
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', input.teamId as TeamId)
    .where('kind', 'in', expanded)
    .select([
      'id',
      'name',
      'kind',
      'config',
      'credentials_id',
      'run_mode',
      'movement_id',
      'fired_movement_name',
    ])
    .execute();
  return rows.map((r) => ({
    id: r.id as unknown as string,
    name: r.name,
    kind: r.kind,
    config: r.config,
    credentialsId: (r.credentials_id as unknown as string) ?? null,
    runMode: parseRunMode(r.run_mode),
    movementId: (r.movement_id as unknown as string) ?? null,
    firedMovementName: (r.fired_movement_name as unknown as string) ?? null,
  }));
}
