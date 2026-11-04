// What an upgrade owes the providers, as a work row.
//
// An upgrade's group moves in one database transaction, and nothing reaches a
// provider while it is open. So the transaction writes the intent: one row
// saying "bring these automations' listens up at their providers". It commits
// with the move and rolls back with it, so a rollback leaves nothing owed and
// an instance dying after the commit loses nothing.
//
// The handler lists what the listens watch and syncs the team's subscriptions.
// A listen it could not bring up fails the row, which the drain retries with
// backoff for as long as it takes (a credential that needs reconnecting can
// take days): the upgrade has already answered `upgraded`, and asking again
// answers `already_current`, so this row is the only retry there is. Failing
// repeatedly raises an issue on the automation, on the surface a refused firing
// uses; coming up closes it.
//
// One row per group, not per member: the subscription sync is per team, and two
// at once could register the same subscription twice.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { WorkContext } from '../../work/kinds';

import { logger } from 'movement-engine/public/log';
import { savedListens, type SavedListen } from '../../inbound/listen_door';
import { listenEdgeKeysOf } from '../../inbound/listen_edge';
import { resolveAndArm, resolvesListen } from '../../inbound/listen_resolve';
import { registerWorkHandler, WorkKeepsTrying } from '../../work/drain';
import { enqueueWork } from '../../work/store';
import { withTeamContext } from './firing_context';
import { recordMovementFailureIssue, resolveMovementIssuesOfClass } from './issues';
import { syncListenSubscriptions } from './listen_subscriptions';

const WORK_KIND = 'bring_up_listens';

/** The issue's failure class: `fingerprintFailure` reads it off the message. */
const NOT_UP_CLASS = 'MOV_LISTENS_NOT_UP';

/** A first failure may be a blip; by the third, a person should know. */
const ISSUE_FROM_ATTEMPT = 3;

const payloadSchema = z.object({ teamId: z.string(), movementIds: z.array(z.string()) });

/** The row's key names the group it owes, so two groups never share a row and a
 *  row's member list is never replaced by another's. */
function keyOf(movementIds: readonly string[]): string {
  const digest = createHash('sha256').update([...new Set(movementIds)].sort().join(',')).digest('hex').slice(0, 32);
  return `${WORK_KIND}:${digest}`;
}

/** Owe the providers `movementIds`' listens. Inside a context transaction the
 *  row joins it, and the drain is told once it commits. */
export async function bringUpListensLater(input: { teamId: string; movementIds: readonly string[] }): Promise<void> {
  await enqueueWork({
    kind: WORK_KIND,
    key: keyOf(input.movementIds),
    teamId: input.teamId,
    payload: { teamId: input.teamId, movementIds: input.movementIds },
  });
}

function unique(texts: readonly string[]): string[] {
  return [...new Set(texts)];
}

async function resolvedFailuresOf(listens: readonly SavedListen[]): Promise<string[]> {
  const failures: string[] = [];
  for (const listen of listens) {
    if (!resolvesListen(listen)) continue;
    const failure = await resolveAndArm(listen);
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

/** Bring `movementIds`' listens up, once. Answers each automation still not
 *  up: its name and why. */
async function bringUp(input: { teamId: TeamId; movementIds: readonly string[] }): Promise<Array<{ movementId: string; name: string; why: string[] }>> {
  const { teamId } = input;
  const listensOf = (movementId: string) => savedListens({ teamId, movementId: movementId as MovementId });

  // Listed first: a subscription per record is made under the records this finds.
  const resolving = new Map<string, string[]>();
  for (const movementId of input.movementIds) resolving.set(movementId, await resolvedFailuresOf(await listensOf(movementId)));

  const { notes, unregistered } = await syncListenSubscriptions({ teamId });
  if (notes.length > 0) logger.warn('[ListensUp] the subscription sync left notes', { teamId, notes });

  const notUp: Array<{ movementId: string; name: string; why: string[] }> = [];
  for (const movementId of input.movementIds) {
    // Read again: what was just listed decides which subscriptions it shares.
    const listens = await listensOf(movementId);
    const digests = new Set(listens.flatMap((listen) => listenEdgeKeysOf(listen, ['connection', 'scope']).map(({ digest }) => digest)));
    const why = unique([...(resolving.get(movementId) ?? []), ...unregistered.filter(({ digest }) => digests.has(digest)).map(({ note }) => note)]);
    const [first] = listens;
    if (first !== undefined && why.length > 0) notUp.push({ movementId, name: first.file, why });
  }
  return notUp;
}

/** The issue for a bring up that stopped on an error rather than answering: the
 *  people it concerns hear of it as they would of a listen that stayed down. */
async function raiseForError(input: { teamId: TeamId; movementIds: readonly string[]; error: unknown }): Promise<void> {
  const why = input.error instanceof Error ? input.error.message : String(input.error);
  for (const movementId of input.movementIds) {
    const [first] = await savedListens({ teamId: input.teamId, movementId: movementId as MovementId });
    if (first === undefined) continue;
    await recordMovementFailureIssue({
      teamId: input.teamId,
      movementId,
      movementName: first.file,
      triggerName: 'its listens',
      message: `${NOT_UP_CLASS}: this automation receives no events on these listens until they are brought up at their providers, which keeps being tried: it stopped on an error (${why})`,
    });
  }
}

async function runBringUp(payload: unknown, ctx: WorkContext): Promise<void> {
  const { teamId, movementIds } = payloadSchema.parse(payload);
  await withTeamContext(teamId as TeamId, async () => {
    let notUp: Awaited<ReturnType<typeof bringUp>>;
    try {
      notUp = await bringUp({ teamId: teamId as TeamId, movementIds });
    } catch (error) {
      // The retry the drain gives a thrown row is the same one; only saying so
      // is added. Saying so must not hide the error it is about.
      if (ctx.attempts >= ISSUE_FROM_ATTEMPT) {
        await raiseForError({ teamId: teamId as TeamId, movementIds, error }).catch((raising: unknown) =>
          logger.error('[ListensUp] the issue for a failed bring up could not be raised', { teamId, error: raising instanceof Error ? raising.message : String(raising) }),
        );
      }
      throw error;
    }
    const stillDown = new Set(notUp.map(({ movementId }) => movementId));
    for (const movementId of movementIds) {
      if (!stillDown.has(movementId)) await resolveMovementIssuesOfClass({ movementId, failureClass: NOT_UP_CLASS });
    }
    if (notUp.length === 0) return;
    if (ctx.attempts >= ISSUE_FROM_ATTEMPT) {
      for (const { movementId, name, why } of notUp) {
        await recordMovementFailureIssue({
          teamId,
          movementId,
          movementName: name,
          triggerName: 'its listens',
          message: `${NOT_UP_CLASS}: this automation receives no events on these listens until they are brought up at their providers, which keeps being tried: ${why.join('; ')}`,
        });
      }
    }
    throw new WorkKeepsTrying(`listens not brought up at their providers: ${notUp.flatMap(({ name, why }) => why.map((line) => `${name}: ${line}`)).join('; ')}`);
  });
}

export function registerBringUpListensWork(): void {
  registerWorkHandler(WORK_KIND, { run: runBringUp });
}
