// Ownership gating for inbound events — the §6.4b rule, for a pin from before
// a module's listens stopped being limited: an inbound event is processed only
// when its actor resolves to a REGISTERED team user. One rule covers both
// hazards: the bot's own reply re-ingested (never a registered user → drops →
// no self-loop) and an unregistered person addressing the bot (drops —
// accepted implication: listeners never fire on messages from
// externals/guests).
//
// The module says when the rule ended (its manifest's `listensLimitedBefore`,
// Slack's 0.16.0). From that release a listen is judged by its filter alone,
// at the door, so the gate never runs for a pin of it or later.
//
// The resolver runs WITHOUT trigger context, deliberately: resolveActingUser's
// creator override and fallbackToCreatorIfActorUnregistered authenticate an
// UNRESOLVED actor as the trigger creator — attribution conveniences that
// would let the bot's own echo pass an ownership gate.
//
// Fail CLOSED: no candidates, no match, or a resolution error all drop —
// failing open reopens the loop this gate exists to kill. The dispatcher
// marks the stored receipt suppressed, so nothing is lost: a wrongly-dropped
// event is visible and replayable.

import type { LanguageVersion } from 'movement-lang';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { z } from 'zod';
import { languageVersionStanding } from 'movement-lang';
import { neverAsAny } from 'movement-engine/public/types';

import { actorCandidateSchema, actorIdentitySchema, type ActingUser, type ActorCandidate, type ActorIdentity } from '../adapters/acting_user/actor';
import { resolveActingUser } from '../adapters/acting_user/resolve';
import { getAdapterManifest } from '../adapters/registry';

export type ActorGateDisposition =
  | { kind: 'proceed' }
  | { kind: 'drop'; reason: string };

/** Whether a listen on `adapterType`'s module, pinned to `pin`, is gated: its
 *  module's listens were limited before a release, and `pin` is of an earlier
 *  key. A pin that is no release is gated (fail closed). */
export function inboundActorGateEnabled(adapterType: string, pin: LanguageVersion): boolean {
  const limitedBefore = getAdapterManifest(adapterType)?.listensLimitedBefore;
  if (limitedBefore === undefined) return false;
  const standing = languageVersionStanding(pin, limitedBefore);
  switch (standing) {
    case 'compatible':
    case 'newer':
      return false;
    case 'olderKey':
    case 'malformed':
      return true;
    default:
      return neverAsAny(standing);
  }
}

/** A source adapter as the gate reads it: a module from before 0.16 may offer
 *  who acted (`getActorCandidates`); this release's modules do not. */
export interface ActorSource {
  adapterType: string;
  getActorCandidates?(input: { event: TriggerEvent }): Promise<unknown>;
}

type Resolve = (input: {
  teamId: TeamId;
  getCandidates: () => Promise<ActorCandidate[]>;
}) => Promise<ActingUser | null>;

export async function consultActorGate(input: {
  teamId: TeamId;
  /** The pin of the automation whose listen the event set off. */
  pin: LanguageVersion;
  sourceAdapter: ActorSource | null;
  event: TriggerEvent;
  /** Injectable for tests; defaults to the real Listen-Fire-side resolution. */
  resolve?: Resolve;
}): Promise<ActorGateDisposition> {
  if (!inboundActorGateEnabled(input.event.adapterType, input.pin)) return { kind: 'proceed' };

  // The module's own candidates where it offers them; else who acted on the
  // arrival, as its module said at the door (adapter protocol 2.7 to 2.9).
  const source = input.sourceAdapter;
  const actor = arrivalActor(input.event);
  const getCandidates =
    source?.getActorCandidates !== undefined
      ? async (): Promise<ActorCandidate[]> => z.array(actorCandidateSchema).parse(await source.getActorCandidates?.({ event: input.event }))
      : actor !== undefined
        ? async (): Promise<ActorCandidate[]> => [{ identity: actor, source: 'originator' }]
        : undefined;
  if (getCandidates === undefined) {
    return {
      kind: 'drop',
      reason:
        `${input.event.adapterType}: inbound requires a registered actor, but neither the source ` +
        'adapter nor the arrival names one — dropping (fail closed).',
    };
  }
  const resolve: Resolve = input.resolve ?? resolveActingUser;
  try {
    const user = await resolve({ teamId: input.teamId, getCandidates });
    if (user) return { kind: 'proceed' };
    return {
      kind: 'drop',
      reason:
        `${input.event.adapterType}: the inbound actor does not resolve to a registered ` +
        'team user (unregistered sender, or the bot\'s own message) — dropped by the ' +
        'ownership gate.',
    };
  } catch (err) {
    return {
      kind: 'drop',
      reason:
        `${input.event.adapterType}: the inbound actor could not be resolved ` +
        `(${err instanceof Error ? err.message : String(err)}) — dropped (fail closed; ` +
        'the event receipt is replayable).',
    };
  }
}

/** Who acted on the event's arrival, as a module from before 0.16 named them
 *  (protocol 2.10 retired the field, so it is read as untyped data). */
function arrivalActor(event: TriggerEvent): ActorIdentity | undefined {
  const arrival: unknown = event.arrival;
  if (typeof arrival !== 'object' || arrival === null || !('actor' in arrival)) return undefined;
  const parsed = actorIdentitySchema.safeParse(arrival.actor);
  return parsed.success ? parsed.data : undefined;
}
