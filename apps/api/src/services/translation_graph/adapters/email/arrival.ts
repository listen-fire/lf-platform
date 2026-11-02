// An inbound email as the arrival a listen on the shared inbox judges: one
// record on `Emails`, its fields the provider's payload with the body a
// listen reads (`content`) and the key it was sent to (`Key`), identified by
// its Message-Id.

import type { Arrival } from 'engine-contracts';
import type { ActingUser } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import { EMAILS_EDGE, EMAIL_KEY_FIELD } from '@listen-fire/email/types';
import { normalisedBody } from '@listen-fire/email/adapter';
import { inboxKeyOf } from '@listen-fire/email/address';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';

import { resolveActingUser } from '../acting_user/resolve';
import { createEmailAdapter, EMAIL_ADAPTER_TYPE } from './index';

export function inboundEmailArrival(input: { payload: Record<string, unknown>; fallbackIdentity: string }): Exclude<Arrival, { gone: true }> {
  const { payload } = input;
  const messageId = typeof payload['messageId'] === 'string' && payload['messageId'].length > 0 ? payload['messageId'] : undefined;
  const recipient = typeof payload['recipient'] === 'string' ? payload['recipient'] : undefined;
  return {
    edge: EMAILS_EDGE,
    identity: messageId ?? input.fallbackIdentity,
    landing: { recordType: 'Email', fields: { ...payload, content: normalisedBody(payload), [EMAIL_KEY_FIELD]: inboxKeyOf(recipient) } },
  };
}

/**
 * The team member an inbound email acts as, or null for none: the email
 * module's candidates for the run trigger its arrival makes (as every run of
 * it reads them, the sender from the arrival's actor and the forwarding
 * recipients from its fields), mapped through the team's members.
 */
export async function emailActingUser(input: { teamId: TeamId; arrival: Exclude<Arrival, { gone: true }> }): Promise<ActingUser | null> {
  const adapter = createEmailAdapter({ teamId: input.teamId });
  const trigger = arrivalTriggerOf({ pipelineInputId: 'auth-gate', adapterType: EMAIL_ADAPTER_TYPE, arrival: input.arrival, now: new Date() });
  return resolveActingUser({ teamId: input.teamId, getCandidates: () => adapter.getActorCandidates({ event: trigger }) });
}
