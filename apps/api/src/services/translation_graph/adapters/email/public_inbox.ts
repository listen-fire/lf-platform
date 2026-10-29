// Public inboxes: inbound routing keys a team has opened to mail from anyone.
//
// The inbound door normally decides a message's team from its SENDER, because
// the `+key` part of the deployment's address is a slug anyone can guess. A
// team that runs a deal inbox wants the opposite for one key: founders and
// introducers with no account write to it, and the team answers for whatever
// arrives. That decision belongs to the address, not to the program, so it is
// a claim on the key and an automation simply listens on it.
//
// One team per key, enforced when it is claimed (a unique index): a second
// team asking for a held key is refused by name, so mail is never dropped for
// a clash discovered at delivery. Whoever claimed it is who a run acts as when
// the sender is not on the team, as a Gmail run acts as the mailbox's owner.

import type { ActingUser } from 'movement-engine/public/adapter';

import { EMAIL_ADAPTER_TYPE, inboundRoutingAddress } from '@listen-fire/email';

import { getAutomationsQb } from '../../../../lib/kysely';
import { principalDirectory } from '../../../principal';
import { loadActingUserById, type ActingUserTriggerContext } from '../acting_user_shared';
import { resolveAdapterSlug } from '../registry';

/** The longest key a claim takes: the email listen's own routing-key limit. */
const PUBLIC_INBOX_KEY_MAX = 30;

interface PublicInbox {
  key: string;
  teamId: string;
  claimedByUserId: string;
  createdAt: Date;
  /** The full address mail is sent to, when this deployment has one. */
  address: string | null;
}

type ClaimPublicInboxResult =
  | { status: 'claimed'; inbox: PublicInbox }
  | { status: 'already_claimed'; inbox: PublicInbox }
  | { status: 'held_by_another_team'; key: string; teamId: string }
  | { status: 'invalid_key'; reason: string };

type ReleasePublicInboxResult =
  | { status: 'released'; key: string }
  | { status: 'not_claimed'; key: string }
  | { status: 'held_by_another_team'; key: string; teamId: string };

function addressFor(key: string): string | null {
  const address = inboundRoutingAddress();
  return address === null ? null : `${address.prefix}${key}${address.suffix}`;
}

function toInbox(row: { key: string; team_id: string; claimed_by_user_id: string; created_at: Date }): PublicInbox {
  return {
    key: row.key,
    teamId: row.team_id,
    claimedByUserId: row.claimed_by_user_id,
    createdAt: row.created_at,
    address: addressFor(row.key),
  };
}

/** Why `key` cannot be a routing key, or null when it can. */
function invalidKeyReason(key: string): string | null {
  if (key.length === 0) return 'a key cannot be empty';
  if (key.length > PUBLIC_INBOX_KEY_MAX) return `a key is at most ${PUBLIC_INBOX_KEY_MAX} characters`;
  if (/[\s@+]/.test(key)) return 'a key cannot contain spaces, "@" or "+": it is the part between "+" and "@"';
  return null;
}

/**
 * The claim on `key`, whichever team holds it, or null. The one deliberate
 * deployment-wide read: the door has no team until this answers.
 * Case-insensitive, as the column is.
 */
async function findPublicInbox(key: string): Promise<PublicInbox | null> {
  const row = await getAutomationsQb(['public_inbox'])
    .selectFrom('public_inbox')
    .where('key', '=', key)
    .select(['key', 'team_id', 'claimed_by_user_id', 'created_at'])
    .executeTakeFirst();
  return row === undefined ? null : toInbox(row);
}

/** The team's public inboxes, by key. */
async function listPublicInboxes(teamId: string): Promise<PublicInbox[]> {
  const rows = await getAutomationsQb(['public_inbox'])
    .selectFrom('public_inbox')
    .where('team_id', '=', teamId)
    .select(['key', 'team_id', 'claimed_by_user_id', 'created_at'])
    .orderBy('key')
    .execute();
  return rows.map(toInbox);
}

/**
 * Open `key` to mail from anyone, for `teamId`. A key the team already holds
 * is left as it is (its claimant included); a key another team holds is
 * refused, naming that team so the operator surface can say who.
 */
async function claimPublicInbox(input: {
  teamId: string;
  key: string;
  claimedByUserId: string;
}): Promise<ClaimPublicInboxResult> {
  const key = input.key.trim();
  const invalid = invalidKeyReason(key);
  if (invalid !== null) return { status: 'invalid_key', reason: invalid };

  const inserted = await getAutomationsQb(['public_inbox'])
    .insertInto('public_inbox')
    .values({ key, team_id: input.teamId, claimed_by_user_id: input.claimedByUserId })
    .onConflict((oc) => oc.column('key').doNothing())
    .returning(['key', 'team_id', 'claimed_by_user_id', 'created_at'])
    .executeTakeFirst();
  if (inserted !== undefined) return { status: 'claimed', inbox: toInbox(inserted) };

  const held = await findPublicInbox(key);
  // Released between the insert and the read: the caller may simply ask again.
  if (held === null) return claimPublicInbox(input);
  if (held.teamId === input.teamId) return { status: 'already_claimed', inbox: held };
  return { status: 'held_by_another_team', key: held.key, teamId: held.teamId };
}

/** Close `key` again. Only the team holding it may. */
async function releasePublicInbox(input: { teamId: string; key: string }): Promise<ReleasePublicInboxResult> {
  const key = input.key.trim();
  const deleted = await getAutomationsQb(['public_inbox'])
    .deleteFrom('public_inbox')
    .where('key', '=', key)
    .where('team_id', '=', input.teamId)
    .returning('key')
    .executeTakeFirst();
  if (deleted !== undefined) return { status: 'released', key: deleted.key };

  const held = await findPublicInbox(key);
  if (held === null) return { status: 'not_claimed', key };
  return { status: 'held_by_another_team', key: held.key, teamId: held.teamId };
}

/**
 * Who a run of an email listener acts as when its sender is nobody on the
 * team: whoever claimed the listener's key as this team's public inbox, while
 * they may still act for the team. Null for any other listener, and for a key
 * that is not this team's public inbox — the run then has no acting user, as
 * before.
 */
async function publicInboxActor(input: {
  teamId: string;
  trigger: ActingUserTriggerContext | undefined;
}): Promise<ActingUser | null> {
  const trigger = input.trigger;
  if (trigger === undefined || resolveAdapterSlug(trigger.kind) !== EMAIL_ADAPTER_TYPE) return null;
  const config = trigger.config;
  const key = typeof config === 'object' && config !== null && 'key' in config ? config.key : undefined;
  if (typeof key !== 'string' || key.length === 0) return null;

  const inbox = await findPublicInbox(key);
  if (inbox === null || inbox.teamId !== input.teamId) return null;
  const claimant = await principalDirectory().userById({ id: inbox.claimedByUserId, teamId: input.teamId });
  if (claimant?.hasAccess !== true) return null;
  return loadActingUserById(inbox.claimedByUserId);
}

export {
  PUBLIC_INBOX_KEY_MAX,
  publicInboxActor,
  claimPublicInbox,
  findPublicInbox,
  listPublicInboxes,
  releasePublicInbox,
  type ClaimPublicInboxResult,
  type PublicInbox,
  type ReleasePublicInboxResult,
};
