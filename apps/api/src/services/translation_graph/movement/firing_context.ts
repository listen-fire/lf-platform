// A firing always runs as somebody, inside its team.
//
// Every way a movement fires off a REQUEST inherits that request's Context —
// tRPC and REST get one from the auth middleware, the WhatsApp door builds its
// own, the dev CLIs wrap explicitly. The BACKGROUND workers (the cron
// scheduler, the pollers, the two resume workers, the callback firer) call
// straight in with none, and the services that scope themselves by the ambient
// identity then throw. The one that hurt is text persistence: every page a
// plugin fetches is stored through it, the plugin's catch turns the throw into
// a warning, and a scheduled movement quietly fetched nothing on every run.
//
// So the Context is established HERE, at the seam every firing passes through,
// rather than in each worker — a seventh worker cannot forget it.
//
// And it is established whatever is already in scope. A firing used to keep
// any ambient Context it found, meaning to stay attributed to a requester. But
// Node carries the identity of whatever scheduled a piece of work into it, so
// what it found was as often a stranger's: the drain loop, kicked by a webhook
// on the public routes, ran a team's email firing as the public team, and the
// deck that run fetched was stored there. A firing now acts as its own team;
// only a requester handed in explicitly, on the same team, is kept.
//
// An email run acts as the person the message itself resolves to — the sender
// when they are on the team, or whoever claimed a public inbox's key — on a
// fresh firing and on every resume of it (each is handed the run's original
// event). The engine is handed that event naming the trigger it fired through
// (`engineEvent`): a version from before 0.16 resolves its `@user_*` against
// that trigger by the same resolution, so the identity a run's services use
// and the user it reports are one person.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { ActingUser } from '../adapters/acting_user/actor';
import type { ActingUserTriggerContext } from '../adapters/acting_user_shared';
import { isAccess, meets, type Principal } from 'principal';

import { Context, runWithoutAmbientIdentity } from '../../context';
import { runInSystemContext } from '../../context/utils';
import { userPrincipal } from '../../principal';
import { logger } from 'movement-engine/public/log';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { resolveActingUser } from '../adapters/acting_user/resolve';
import { EMAIL_ADAPTER_TYPE } from '../adapters/email';
import { emailActorCandidates } from '../adapters/email/arrival';
import { resolveAdapterSlug } from '../adapters/registry';

/** What a firing is, as far as who it acts as goes. */
interface Firing {
  teamId: TeamId;
  triggerId: string;
  /** The event the run fired on; a resume is handed the original. */
  event: TriggerEvent;
  /** Whoever asked for this firing by hand, when somebody did. Kept only when
   *  they act in the firing's own team. */
  requester?: Principal;
}

/**
 * The event as the engine is handed it: naming the trigger it fired through.
 * A version from before 0.16 passes that name back when its `@user_*` asks the
 * host who the run acts as, and only with it does the host apply the trigger's
 * own rules — a public inbox's claimant, a creator override. 0.16 has no
 * `@user_*` and reads no such name.
 */
function engineEvent(firing: Firing): TriggerEvent {
  return { ...firing.event, triggerEntryId: firing.triggerId };
}

/**
 * Run one firing inside a Context bound to its team, never inside whatever
 * Context or Principal the caller happens to have in scope.
 */
async function withFiringContext<T>(
  firing: Firing,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithoutAmbientIdentity(async () => {
    const principal = await firingPrincipal(firing);
    if (principal === undefined) return runInSystemContext(fn);
    const ctx = new Context();
    ctx.bindPrincipal(principal);
    return ctx.runAsync(fn);
  });
}

/** Who the firing acts as: its requester when they act in its team, else the
 *  team member `firingActor` names; undefined when there is nobody. */
async function firingPrincipal(firing: Firing): Promise<Principal | undefined> {
  const { requester } = firing;
  if (requester !== undefined) {
    if (requester.teamId === firing.teamId) return requester;
    logger.warn('[MovementEngine] a requester from another team was handed a firing — acting as the firing’s own team', {
      triggerId: firing.triggerId,
      teamId: firing.teamId,
      requesterTeamId: requester.teamId,
    });
  }

  try {
    const userId = await firingActor(firing);
    if (userId !== undefined) return userPrincipal({ userId, teamId: firing.teamId as unknown as string });
    // Nobody to act as at all — an orphaned trigger, or a team with no
    // members left. Say so: the team-scoped reads inside the run will fail.
    logger.warn('[MovementEngine] firing has no user to act as — running system-scoped', {
      triggerId: firing.triggerId,
      teamId: firing.teamId,
    });
  } catch (err) {
    // Establishing the identity must never be the thing that crashes a
    // dispatch — the firing's own error containment is INSIDE `fn`.
    logger.error('[MovementEngine] could not resolve the firing identity — running system-scoped', {
      triggerId: firing.triggerId,
      teamId: firing.teamId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return undefined;
}

/**
 * Who a background firing acts as. An email listener's run acts as whoever the
 * message resolves to (`emailActor`). Any other listener's — and an email whose
 * message resolves to nobody — acts as the person who authored the listener,
 * while they are still on the team. Failing that, the team's longest-standing
 * member with write access — an authorless or inherited trigger still belongs
 * to the team, and the team is what scopes everything the run touches.
 */
async function firingActor(firing: Firing): Promise<string | undefined> {
  const trigger = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .select(['id', 'kind', 'config', 'created_by_user_id'])
    .where('id', '=', firing.triggerId as TriggerId)
    .executeTakeFirst();
  const createdByUserId = trigger?.created_by_user_id ?? null;
  const sender =
    trigger === undefined
      ? null
      : await emailActor({
          teamId: firing.teamId,
          trigger: { id: trigger.id, kind: trigger.kind, config: trigger.config, createdByUserId },
          event: firing.event,
        });
  if (sender !== null) return sender.id;
  return teamActor({ teamId: firing.teamId, preferredUserId: createdByUserId });
}

/**
 * Who an email listener's run acts as: the message's sender when they are on
 * the team, else whoever claimed the key as a public inbox. Null for any other
 * listener.
 */
async function emailActor(input: {
  teamId: TeamId;
  trigger: ActingUserTriggerContext;
  event: TriggerEvent;
}): Promise<ActingUser | null> {
  if (resolveAdapterSlug(input.trigger.kind) !== EMAIL_ADAPTER_TYPE) return null;
  return resolveActingUser({
    teamId: input.teamId,
    trigger: input.trigger,
    event: input.event,
    getCandidates: async () => emailActorCandidates(input.event.arrival?.landing.fields ?? {}),
  });
}

/** `preferredUserId` while they are still on the team, else the team's
 *  longest-standing member with write access. */
async function teamActor(input: {
  teamId: TeamId;
  preferredUserId: string | null;
}): Promise<string | undefined> {
  const members = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id', 'access'])
    .where('team_id', '=', input.teamId)
    .orderBy('created_at', 'asc')
    .execute();
  const preferred = input.preferredUserId;
  if (preferred !== null && members.some((m) => (m.user_id as unknown as string) === preferred)) {
    return preferred;
  }
  const fallback = members.find((m) => isAccess(m.access) && meets(m.access, 'write')) ?? members[0];
  return fallback === undefined ? undefined : (fallback.user_id as unknown as string);
}

/**
 * Background work on a team's automations that is not a firing — the deploy
 * check validating them — runs inside the team as the firing fallback's member,
 * for the reason a firing does: team-scoped services read the ambient identity.
 */
async function withTeamContext<T>(teamId: TeamId, fn: () => Promise<T>): Promise<T> {
  return runWithoutAmbientIdentity(async () => {
    const userId = await teamActor({ teamId, preferredUserId: null });
    if (userId === undefined) return runInSystemContext(fn);
    const ctx = new Context();
    ctx.bindPrincipal(userPrincipal({ userId, teamId: teamId as unknown as string }));
    return ctx.runAsync(fn);
  });
}

export { engineEvent, withFiringContext, withTeamContext };
