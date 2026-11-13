// What holds an automation at its version whatever its diagnostics say: a move
// would change what it does (an edit nobody confirmed goes live), or strand a run
// (one parked on a key, which only its own version can resume, and on a version
// this release does not run nothing here can). Its own module
// because it reads the rows; `language_upgrade.ts` decides what to do with the
// answer.

import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { LanguageVersion } from 'movement-lang';
import type { MovementRow } from './store';

import { sql } from 'kysely';

import { readOnlyByFrozenParser } from './language_route';

import { getAutomationsQb } from '../../../lib/kysely';
import { resolveAdapterSlug } from '../adapters/registry';
import { loadPinnedVersion } from './version_store';

/** Why a member of an upgrading group cannot move yet, whatever its diagnostics:
 *  one line per reason, each naming the member. */
export async function holdsOnMoving(group: readonly MovementRow[]): Promise<string[]> {
  const holds: string[] = [];
  for (const member of group) {
    // An upgrade rewrites and ships the latest text. An edit that stopped at
    // needs confirmation has not shipped, so moving it would put behaviour nobody
    // confirmed live.
    if (member.currentVersionId !== null) {
      const shipped = await loadPinnedVersion(member.currentVersionId);
      if (shipped !== null && shipped.source !== member.source) {
        holds.push(`${member.name} has an edit waiting for confirmation, which an upgrade would put live: confirm or discard that edit first`);
      }
    }
  }
  const held = await runsWaitingOnKeys(group.map((member) => member.id));
  for (const member of group) {
    const waiting = held.get(member.id) ?? [];
    const legacy = waiting.filter((run) => readOnlyByFrozenParser(run.pin)).map((run) => run.id);
    const carried = waiting.filter((run) => !readOnlyByFrozenParser(run.pin)).map((run) => run.id);
    if (carried.length > 0) {
      holds.push(
        `${member.name} has ${carried.length === 1 ? 'a run' : `${carried.length} runs`} waiting on a callback or an await under its current language version (${carried.join(', ')}), which only that version can resume: it stays there until they finish, or cancel them first`,
      );
    }
    // No engine here steps these, so waiting would never end.
    if (legacy.length > 0) {
      const [them, it] = legacy.length === 1 ? ['a run', 'it'] : [`${legacy.length} runs`, 'them'];
      holds.push(
        `${member.name} has ${them} waiting on a question, a callback or a reply under a language version this release does not run (${legacy.join(', ')}), which it cannot resume: cancel ${it}, then upgrade the automation`,
      );
    }
  }
  return holds;
}

/**
 * What is still on its way to a member under its current version, read with the
 * team's doors and the group's listen rows held: a delivery its version has not
 * read, and an event judged for it whose run has not started. Each is that
 * version's to finish, so the move waits for it rather than losing it. Later
 * deliveries see the move, and a run already going finishes where it started.
 * A row buried dead is on its way nowhere.
 *
 * The rows are locked first because a schedule's or a poll's turn holds only its
 * row, not the doors: it has committed, and its event is counted here, or it waits
 * for the row and then finds it moved.
 */
export async function eventsInFlight(group: readonly MovementRow[], teamId: string): Promise<string[]> {
  const triggers = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', 'in', group.map((member) => member.id) as MovementId[])
    .select(['id', 'kind'])
    .orderBy('id')
    .forUpdate()
    .execute();
  if (triggers.length === 0) return [];
  const exec = getAutomationsQb(['work', 'trigger_run']);
  const { rows: reading } = await sql<{ count: string }>`
    select count(*)::text as count from automations.work
    where kind = 'read_delivery' and dead_at is null and team_id = ${teamId}::uuid and payload->>'adapterType' = any(${[...new Set(triggers.map((row) => resolveAdapterSlug(row.kind)))]}::text[])`.execute(exec);
  const { rows: starting } = await sql<{ count: string }>`
    select count(*)::text as count from automations.work w
    where w.kind = 'dispatch_event' and w.dead_at is null and w.team_id = ${teamId}::uuid and w.payload->>'triggerId' = any(${triggers.map((row) => row.id as string)}::text[])
      and not exists (select 1 from automations.trigger_run r where r.trigger_event_id = (w.payload->>'storedEventId')::uuid)`.execute(exec);
  const unread = Number(reading[0]?.count ?? 0);
  const unstarted = Number(starting[0]?.count ?? 0);
  return [
    ...(unread > 0 ? [`${unread} ${unread === 1 ? 'delivery is' : 'deliveries are'} still being read under its current language version`] : []),
    ...(unstarted > 0 ? [`${unstarted} ${unstarted === 1 ? 'event is' : 'events are'} still waiting to start under its current language version`] : []),
  ];
}

/** The runs of each movement parked on a key: an await correlated to an adapter
 *  identity, or a callback still taking calls. Those are written only under a
 *  version that parks on keys, and a person's or a system's call reaches them by
 *  that key, so the automation stays on that version until they finish. */
export async function runsWaitingOnKeys(movementIds: readonly string[]): Promise<Map<string, Array<{ id: string; pin: LanguageVersion }>>> {
  const rows = await getAutomationsQb(['trigger_run', 'movement_version', 'adapter_await', 'callback'])
    .selectFrom('trigger_run')
    .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
    .where('movement_version.movement_id', 'in', [...movementIds] as MovementId[])
    .where('trigger_run.host', '=', 'platform')
    .where('trigger_run.status', 'in', ['running', 'parked'])
    .where((eb) =>
      eb.or([
        eb.exists(eb.selectFrom('adapter_await').select('adapter_await.id').whereRef('adapter_await.run_id', '=', 'trigger_run.id')),
        eb.exists(eb.selectFrom('callback').select('callback.id').whereRef('callback.run_id', '=', 'trigger_run.id').where('callback.status', '=', 'live')),
      ]),
    )
    .select(['movement_version.movement_id', 'movement_version.language_version', 'trigger_run.id'])
    .execute();
  const byMovement = new Map<string, Array<{ id: string; pin: LanguageVersion }>>();
  for (const row of rows) byMovement.set(row.movement_id, [...(byMovement.get(row.movement_id) ?? []), { id: row.id, pin: row.language_version }]);
  return byMovement;
}

