// Who may start a run: an automation's fire list, judged at the door from what
// the platform decided of who acted on each arrival (actors.ts), never from a
// field keyed `Actor`, which a module or a body could have filled. Only an
// arrival that would start a run through a listen is judged: a wait's landing
// is logged and wakes its waits whatever the list says. A run by hand is a
// writer's own, and the list does not judge it. A replay is judged as a fresh
// arrival, except an arrival the list refused before: the writer replaying it
// vouches for it.
//
// A refusal starts nothing and takes no receipt. It is kept as a fact beside the
// delivery, so a writer may replay it.

import { sql } from 'kysely';
import { neverAsAny } from 'movement-engine/public/types';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { Grantee } from '../access/statement';
import type { Exec } from '../lf_store/scope';
import type { ActorDecision } from './actors';

import { CRON_ADAPTER_TYPE } from '../translation_graph/adapters/cron';
import { EMAIL_ADAPTER_TYPE } from '../translation_graph/adapters/email';
import { getAdapterManifest, resolveAdapterSlug } from '../translation_graph/adapters/registry';
import { RemoteAdapterManifestFile } from '../translation_graph/adapters/remote/manifest';
import { getRemoteAdapter } from '../translation_graph/adapters/remote/store';
import { SYSTEM_ADAPTER_TYPE } from '../translation_graph/adapters/system';
import { reportsWhoActed } from './actors';

/** How a module says who acted on what it delivers, which decides whether a
 *  fire list is judged on its arrivals and what satisfies one. */
export type ActorSource =
  /** Nobody acts: a schedule's ticks, the platform's own events. The list is
   *  never judged, and a save does not warn. */
  | 'no_one_acts'
  /** The module does not say who acted, so a rule other than anyone cannot be
   *  applied to it: it fires for anyone who reaches it, as the save warns. */
  | 'not_reported'
  /** Email until its rework: a sender's address is claimed, not proven, and
   *  satisfies a person, team or domain rule, as the save warns. */
  | 'claimed'
  /** The module says who acted: a person, team or domain rule needs `Proven`. */
  | 'reported';

/**
 * How `adapterType`'s module says who acted, from the methods its manifest
 * lists. A module nothing describes is judged as one that says who acted, so
 * an arrival nobody can account for is refused rather than admitted.
 */
export function actorSourceOf(adapterType: string, methods: readonly string[] | undefined): ActorSource {
  const slug = resolveAdapterSlug(adapterType);
  if (slug === CRON_ADAPTER_TYPE || slug === SYSTEM_ADAPTER_TYPE) return 'no_one_acts';
  if (slug === EMAIL_ADAPTER_TYPE) return 'claimed';
  if (methods === undefined) return 'reported';
  return reportsWhoActed(methods) ? 'reported' : 'not_reported';
}

/** `actorSourceOf` a delivery's module: a built-in one by its manifest, one
 *  the team installed remotely by the manifest kept with its install. */
export async function actorSourceFor(team: TeamId, adapterType: string): Promise<ActorSource> {
  const builtin = getAdapterManifest(adapterType)?.methods;
  if (builtin !== undefined) return actorSourceOf(adapterType, builtin);
  const install = await getRemoteAdapter({ teamId: team, adapterType: resolveAdapterSlug(adapterType) });
  const manifest = install === null ? undefined : RemoteAdapterManifestFile.safeParse(install.manifest);
  return actorSourceOf(adapterType, manifest?.success === true ? manifest.data.methods : undefined);
}

/** Whether a fire list lets anyone start a run, which needs no actor. */
export function admitsAnyone(fire: readonly Grantee[]): boolean {
  return fire.some((grantee) => grantee.kind === 'anyone');
}

/** Whether an arrival may start a run. `undecided` is neither: who acted could
 *  not be looked up, and it is kept as an `Arrival Not Judged` fact. */
export type FireVerdict = { kind: 'fires' } | { kind: 'refused'; reason: string } | { kind: 'undecided'; reason: string };

const FIRES: FireVerdict = { kind: 'fires' };

const refused = (reason: string): FireVerdict => ({ kind: 'refused', reason });

type Written = Extract<ActorDecision, { kind: 'written' }>;

/** Stored user ids are lowercase; compare like with like. */
const sameUser = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

/** Whether one entry of a fire list admits who acted. Only a module that
 *  can do no better than a claimed address has it stand in for proof. */
function admits(grantee: Grantee, decided: Written, source: ActorSource): boolean {
  const { actor, addressMatch } = decided;
  const claimed = !actor.Proven && source === 'claimed';
  switch (grantee.kind) {
    case 'anyone':
      return true;
    case 'team':
      return actor.Proven ? actor.Member : claimed && addressMatch !== undefined;
    case 'user':
      return actor.Proven ? sameUser(actor.User, grantee.userId) : claimed && sameUser(addressMatch?.user, grantee.userId);
    case 'domain':
      return (actor.Proven || claimed) && actor.Domain === grantee.domain;
    case 'email':
      return (actor.Proven || claimed) && actor.Email === grantee.address;
    // A phone is never claimed: email, the one claimed source, carries none.
    case 'phone':
      return actor.Proven && actor.Phone === grantee.digits;
    default:
      return neverAsAny(grantee);
  }
}

/**
 * Whether the arrival `decided` was written for may start a run of an
 * automation whose fire list is `fire`, delivered by a module that says who
 * acted as `source` does. A pure function, so judging stays synchronous.
 */
export function fireVerdict(input: { fire: readonly Grantee[]; decided: ActorDecision; source: ActorSource }): FireVerdict {
  const { fire, decided, source } = input;
  if (source === 'no_one_acts' || admitsAnyone(fire)) return FIRES;
  // Nothing stated admits nobody, as every other list does.
  if (fire.length === 0) return refused('nothing states who may fire this automation');
  // The platform cannot tell who acted, so the rule cannot be applied, as the
  // save warns, naming the listen.
  if (source === 'not_reported') return FIRES;
  switch (decided.kind) {
    case 'written':
      if (fire.some((grantee) => admits(grantee, decided, source))) return FIRES;
      return refused(
        decided.actor.Proven || source === 'claimed'
          ? 'who acted is not among who may fire this automation'
          : 'the source system does not vouch for who acted, and who may fire this automation names people, a team or a domain',
      );
    case 'unknown':
      return { kind: 'undecided', reason: 'who acted could not be looked up, so who may fire this automation cannot be judged' };
    case 'nobody':
      return refused('the arrival names no one as having acted, and who may fire this automation names people, a team or a domain');
    // As a module that does not say who acted: its own `Actor` kept the
    // platform from looking, and the save warns of it the same way.
    case 'module':
      return FIRES;
    case 'unneeded':
      return refused('who acted was not looked up');
    default:
      return neverAsAny(decided);
  }
}

// ── A refusal, kept ─────────────────────────────────────────────────────────

/** An arrival a listen's filter took that its automation's fire list did not
 *  let start a run, kept with its delivery for a writer to replay. */
export interface RefusedArrival {
  deliveryId: string;
  pipeline: string;
  /** The arrival's receipt key. */
  arrival: string;
  file: string;
  movement: string;
  edge: string;
  adapter: string;
  reason: string;
  at: string;
}

/** Kept once per delivery, listen and arrival. */
export async function keepRefusedIn(exec: Exec, teamId: string, fact: RefusedArrival): Promise<void> {
  await sql`
    insert into automations.arrival_refused (team_id, delivery_id, pipeline, arrival, file, movement, edge, adapter, reason, noted_at)
    values (${teamId}::uuid, ${fact.deliveryId}::uuid, ${fact.pipeline}::text, ${fact.arrival}::text, ${fact.file}::text, ${fact.movement}::text,
            ${fact.edge}::text, ${fact.adapter}::text, ${fact.reason}::text, date_trunc('milliseconds', ${fact.at}::timestamptz))
    on conflict do nothing`.execute(exec);
}

/** Which of `arrivals` (receipt keys) the listen `pipeline`'s fire list
 *  refused when the delivery `deliveryId` brought them. */
export async function refusedBefore(exec: Exec, input: { teamId: string; deliveryId: string; pipeline: string; arrivals: readonly string[] }): Promise<Set<string>> {
  if (input.arrivals.length === 0) return new Set();
  const { rows } = await sql<{ arrival: string }>`
    select arrival from automations.arrival_refused
    where team_id = ${input.teamId}::uuid and delivery_id = ${input.deliveryId}::uuid and pipeline = ${input.pipeline}::text
      and arrival = any(${[...input.arrivals]}::text[])`.execute(exec);
  return new Set(rows.map((row) => row.arrival));
}
