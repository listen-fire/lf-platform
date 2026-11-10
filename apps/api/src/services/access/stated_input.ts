// A statement as a request gives it: the lists a person chose for a thing they
// create, or change with setAccess. The shapes are the wire's; whether a value
// is well formed (a domain, an address, a phone) is `decide.ts`'s to judge, so
// every path that stores a list judges it alike.

import { z } from 'zod';

import type { CreationStatements } from './decide';
import type { Grantee } from './statement';

const GranteeInput: z.ZodType<Grantee> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('team') }),
  z.object({ kind: z.literal('user'), userId: z.string() }),
  z.object({ kind: z.literal('anyone') }),
  z.object({ kind: z.literal('domain'), domain: z.string() }),
  z.object({ kind: z.literal('email'), address: z.string() }),
  z.object({ kind: z.literal('phone'), digits: z.string() }),
]);

const GranteesInput = z.array(GranteeInput);

/** The lists a new automation is created with. Each is optional here so a save without one is refused by name. */
const CreationStatementsInput: z.ZodType<Partial<CreationStatements>> = z.object({
  read: GranteesInput.optional(),
  write: GranteesInput.optional(),
  fire: GranteesInput.optional(),
});

/** What an agent is told about any list it passes: the choice is its person's. */
const ASK_YOUR_PERSON = 'Ask the person you are working for who should have it; never choose for them.';
const TEAM_OR_MEMBERS = 'Each entry is { kind: "team" } (everyone on the team) or { kind: "user", userId } (one member, by id)';

const LIST_DESCRIPTIONS = {
  use: `Who may use the connection: run automations on it, read through it, and change this list. ${ASK_YOUR_PERSON} ${TEAM_OR_MEMBERS}, and you or the team must be on it.`,
  read: `Who may read the automation. ${ASK_YOUR_PERSON} ${TEAM_OR_MEMBERS}. Whoever may write it may also read it.`,
  write: `Who may change, run and delete the automation, and change who may reach it. ${ASK_YOUR_PERSON} ${TEAM_OR_MEMBERS}, and you or the team must be on it.`,
  fire: `Who may set the automation off through its listens. ${ASK_YOUR_PERSON} ${TEAM_OR_MEMBERS}; for firing only, also { kind: "anyone" }, { kind: "domain", domain: "acme.com" }, { kind: "email", address: "pat@acme.com" } or { kind: "phone", digits: "447700900123" } (digits, country code first).`,
} as const;

/** The refusal when a connection would be created with no statement of who may use it. */
const MISSING_USE_REFUSAL =
  'A new connection needs a statement of who may use it. Ask the person you are working for, then try again with it.';

export { GranteeInput, GranteesInput, CreationStatementsInput, LIST_DESCRIPTIONS, MISSING_USE_REFUSAL };
