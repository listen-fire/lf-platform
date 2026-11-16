// Who may see a kept delivery, or run an automation with one of its events.
// A delivery that recorded its connection is the connection's: whoever may use
// it. One that recorded none (older rows, the mail door, a hook, an emit) is
// for a team admin who may read every automation it reached. A route answers
// `true` exactly as it answers a delivery that does not exist.

import { currentPrincipal, meets } from 'principal';

import type { TeamId } from '../generated/kysely/core/Team';

import { Whose } from '../services/access/whose';
import { deliveryOriginOf } from '../services/inbound/delivery_origin';
import { connectionUnseen, unseen } from './access_route';

async function readsEverythingReached(deliveryId: string, teamId: string): Promise<boolean> {
  const reached = await Whose.automationsReachedBy({ deliveryId, teamIds: [teamId] });
  if (reached.untraced) return false;
  for (const automationId of reached.automationIds) if (await unseen(automationId)) return false;
  return true;
}

/** Whether the caller may not reach the delivery `deliveryId` of `teamId`. */
export async function deliveryUnseen(input: { teamId: string; deliveryId: string }): Promise<boolean> {
  const origin = await deliveryOriginOf({ teamId: input.teamId as TeamId, deliveryId: input.deliveryId });
  if (origin === null) return true;
  if (origin.credentialsId !== null) return connectionUnseen(origin.credentialsId);
  if (!meets(currentPrincipal().access, 'admin')) return true;
  return !(await readsEverythingReached(input.deliveryId, input.teamId));
}
