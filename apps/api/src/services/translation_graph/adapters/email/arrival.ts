// An inbound email as the arrival a listen on the shared inbox judges: one
// record on `Emails`, its fields the provider's payload with the body a
// listen reads (`content`) and the key it was sent to (`Key`), identified by
// its Message-Id.

import type { Arrival } from 'engine-contracts';
import { EMAILS_EDGE, EMAIL_KEY_FIELD } from '@listen-fire/email/types';
import { normalisedBody } from '@listen-fire/email/adapter';
import { inboxKeyOf } from '@listen-fire/email/address';

export function inboundEmailArrival(input: { payload: Record<string, unknown>; fallbackIdentity: string }): Arrival {
  const { payload } = input;
  const messageId = typeof payload['messageId'] === 'string' && payload['messageId'].length > 0 ? payload['messageId'] : undefined;
  const recipient = typeof payload['recipient'] === 'string' ? payload['recipient'] : undefined;
  return {
    edge: EMAILS_EDGE,
    identity: messageId ?? input.fallbackIdentity,
    landing: { recordType: 'Email', fields: { ...payload, content: normalisedBody(payload), [EMAIL_KEY_FIELD]: inboxKeyOf(recipient) } },
  };
}
