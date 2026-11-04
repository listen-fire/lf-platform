// What holds an automation at its version whatever its diagnostics say: a move
// would change what it does (an edit nobody confirmed goes live), or strand a run
// (one parked on a key, which only its own version can resume, and on a legacy id
// nothing here can). Its own module
// because it reads the rows; `language_upgrade.ts` decides what to do with the
// answer.

import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { LanguageVersion } from 'movement-lang';
import type { MovementRow } from './store';

import { isLegacyLanguageVersion } from 'legacy-lang';

import { getAutomationsQb } from '../../../lib/kysely';
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
    const legacy = waiting.filter((run) => isLegacyLanguageVersion(run.pin)).map((run) => run.id);
    const carried = waiting.filter((run) => !isLegacyLanguageVersion(run.pin)).map((run) => run.id);
    if (carried.length > 0) {
      holds.push(
        `${member.name} has ${carried.length === 1 ? 'a run' : `${carried.length} runs`} waiting on a callback or an await under its current language version (${carried.join(', ')}), which only that version can resume: it stays there until they finish, or cancel them first`,
      );
    }
    // No engine here steps these, so waiting would never end.
    if (legacy.length > 0) {
      const [them, it] = legacy.length === 1 ? ['a run', 'it'] : [`${legacy.length} runs`, 'them'];
      holds.push(
        `${member.name} has ${them} waiting on a question, a callback or a reply under a legacy language version (${legacy.join(', ')}), which this release cannot resume: answer ${it} on 0.12.13 before deploying, or cancel ${it}`,
      );
    }
  }
  return holds;
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

