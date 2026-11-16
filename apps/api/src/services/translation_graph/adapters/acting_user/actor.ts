// Who acted on an event, in the shapes a module named them in before 0.16
// (adapter protocol up to 2.9: `getActorCandidates`, an arrival's `actor`).
// 0.16 retired them for claims, a branded field a module publishes, and its
// engine-contracts no longer states them. The platform keeps them for rules
// that are its own rather than the language's: the email door's sender check,
// who an email run acts as, and the Slack gate for a pin from before 0.16.
// A carried version's module still names who acted in them, so what crosses
// from one is checked against these schemas rather than trusted.

import { z } from 'zod';

/** A team member a run acts as. */
export interface ActingUser {
  id: string;
  email: string;
  name?: string | null;
}

/** Who an event says acted, whether or not they are on the team. `scheme`
 *  says how it maps to a member: by address, by phone, or not at all. */
export const actorIdentitySchema = z.object({
  identifier: z.string(),
  scheme: z.enum(['email', 'phone', 'opaque']),
  adapterType: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  proven: z.boolean().optional(),
});
export type ActorIdentity = z.infer<typeof actorIdentitySchema>;

/** One input to the acting-user resolution: who sent it (`originator`,
 *  matched against members' own addresses) or the forwarding inbox that
 *  delivered it (`relay`, matched against service addresses only). */
export const actorCandidateSchema = z.object({
  identity: actorIdentitySchema,
  source: z.enum(['originator', 'relay']),
});
export type ActorCandidate = z.infer<typeof actorCandidateSchema>;
