// An inbound email as the arrival a listen on the shared inbox judges: one
// record on `Emails`, its fields the provider's payload with the body a
// listen reads (`content`) and the key it was sent to (`Key`), identified by
// its Message-Id, as the email module's own door builds it.
//
// Who sent it is the platform's to read. The email module stopped naming a
// sender in 0.16 (it publishes no claim), but the door's sender check and who
// an email run acts as are the platform's own rules, so the parse the module
// used to make (`getActorCandidates`, up to email 0.13) lives here.

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import { EMAILS_EDGE, EMAIL_KEY_FIELD } from '@listen-fire/email/types';
import { forwardedThrough, normalisedBody } from '@listen-fire/email/adapter';
import { inboxKeyOf } from '@listen-fire/email/address';
import { parseEmailAddress } from '@listen-fire/email';

import type { ActingUser, ActorCandidate } from '../acting_user/actor';
import { resolveActingUser } from '../acting_user/resolve';
import { EMAIL_ADAPTER_TYPE } from './index';

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
 * The team member an inbound email acts as, or null for none: its candidates
 * (`emailActorCandidates`) mapped through the team's members.
 */
export async function emailActingUser(input: { teamId: TeamId; arrival: Exclude<Arrival, { gone: true }> }): Promise<ActingUser | null> {
  const candidates = emailActorCandidates(input.arrival.landing.fields);
  return resolveActingUser({ teamId: input.teamId, getCandidates: async () => candidates });
}

/**
 * Who an email's fields say acted: its sender (the envelope sender, else its
 * `From` header) as the originator, then each inbox it was forwarded through
 * and the address it was sent to as relays, which only a service address
 * matches. The address it was sent to is a routing key anyone can write to, so
 * it never matches a member's own address.
 */
export function emailActorCandidates(fields: Record<string, unknown>): ActorCandidate[] {
  const candidates: ActorCandidate[] = [];
  const sender = parseEmailAddress(senderOf(fields));
  if (sender !== null) {
    candidates.push({ identity: { identifier: sender, scheme: 'email', adapterType: EMAIL_ADAPTER_TYPE, email: sender }, source: 'originator' });
  }
  const relays = forwardedThrough(fields);
  const recipient = fields['recipient'];
  if (typeof recipient === 'string') {
    for (const entry of recipient.split(/[;, ]+/)) {
      const address = parseEmailAddress(entry);
      if (address !== null && !relays.includes(address)) relays.push(address);
    }
  }
  for (const relay of relays) {
    candidates.push({ identity: { identifier: relay, scheme: 'email', adapterType: EMAIL_ADAPTER_TYPE, email: relay }, source: 'relay' });
  }
  return candidates;
}

function senderOf(fields: Record<string, unknown>): string | undefined {
  const sender = fields['sender'];
  return typeof sender === 'string' && sender.length > 0 ? sender : headerOf(fields, 'From');
}

/** A header by name, either way a provider posts it: as a field of its own,
 *  or in `message-headers` (a list of pairs, parsed or as JSON text). */
function headerOf(fields: Record<string, unknown>, name: string): string | undefined {
  const flat = fields[name];
  if (typeof flat === 'string' && flat.length > 0) return flat;
  const target = name.toLowerCase();
  for (const pair of headerPairs(fields['message-headers'])) {
    if (!Array.isArray(pair)) continue;
    const [key, value] = pair;
    if (typeof key === 'string' && key.toLowerCase() === target && typeof value === 'string') return value;
  }
  return undefined;
}

function headerPairs(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
