// Hearing that who a host function answers for may have changed: Postgres
// LISTEN on the channel the membership triggers NOTIFY (schema.sql,
// `core.team_answers_notify` and `automations.team_answers_notify`), so a write
// through any api instance reaches every instance's cache.
//
// One channel carries every team. A payload names a team (`team:<id>`, a
// membership changed) or a user (`user:<id>`, their email, phone or granted
// access changed), and a user is resolved to the teams they belong to here,
// where both the core and automations tables may be read in turn.
//
// The connection is opened by the first caller that needs to hear (`ready`) and
// again by the next after it drops. A drop forgets every kept answer: a change
// made while nothing listened is a change nobody heard, and a stale "is a
// member" is the one answer that must not outlive its cause.

import { Client } from 'pg';
import { logger } from 'movement-engine/public/log';

import type { UserId } from '../../generated/kysely/core/User';
import { userIdSchema } from '../../lib/user_id';

const CLIENT_KEEPALIVE_DELAY_MS = 30_000;

/** The channel the triggers notify. */
export const TEAM_ANSWERS_CHANNEL = 'lf_team_answers';

export type TeamAnswerChange = { kind: 'team'; id: string } | { kind: 'user'; id: UserId };

/** A trigger's payload, read at the boundary: anything else is not one of ours. */
export function teamAnswerChangeOf(payload: string | undefined): TeamAnswerChange | null {
  const match = /^(team|user):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(payload ?? '');
  if (match === null) return null;
  const [, kind, id] = match;
  if (kind === 'team') return { kind, id };
  const userId = userIdSchema.safeParse(id);
  return userId.success ? { kind: 'user', id: userId.data } : null;
}

export interface TeamAnswerFeedOptions {
  connectionString: string;
  /** What to do for a team whose answers may have changed: `membership` when
   *  who belongs to it changed, `person` when only how a member is reached did
   *  (their email, phone or granted access). */
  changed(input: { teamId: string; why: 'membership' | 'person' }): void | Promise<void>;
  /** The teams a user is a member of. */
  teamsOf(userId: UserId): Promise<string[]>;
  /** The connection was lost, or has just been made again: any team may have changed unheard. */
  lost(): void;
}

export interface TeamAnswerFeed {
  /** Resolves once the channel is listened on: a change committed after that
   *  is never missed. Rejects when the database cannot be reached. */
  ready(): Promise<void>;
  /** Ends the connection (a test's teardown; the server holds it for good). */
  close(): Promise<void>;
}

export function postgresTeamAnswerFeed(options: TeamAnswerFeedOptions): TeamAnswerFeed {
  let connecting: Promise<void> | null = null;
  let live: Client | null = null;

  async function heard(change: TeamAnswerChange): Promise<void> {
    try {
      if (change.kind === 'team') {
        await options.changed({ teamId: change.id, why: 'membership' });
        return;
      }
      for (const teamId of await options.teamsOf(change.id)) await options.changed({ teamId, why: 'person' });
    } catch (error) {
      // Not knowing which teams a user is in leaves any of them stale.
      logger.warn('[team-answers] could not resolve a change; every kept answer is forgotten', {
        error: error instanceof Error ? error.message : String(error),
      });
      options.lost();
    }
  }

  function dropped(from: Client, error?: unknown): void {
    if (live !== from) return;
    live = null;
    connecting = null;
    if (error !== undefined) {
      logger.warn('[team-answers] the change connection dropped', { error: error instanceof Error ? error.message : String(error) });
    }
    options.lost();
    from.end().catch(() => undefined);
  }

  async function connect(): Promise<void> {
    const fresh = new Client({ connectionString: options.connectionString, keepAlive: true, keepAliveInitialDelayMillis: CLIENT_KEEPALIVE_DELAY_MS });
    fresh.on('notification', (message) => {
      const change = teamAnswerChangeOf(message.payload);
      if (change !== null) void heard(change);
    });
    fresh.on('error', (error) => dropped(fresh, error));
    fresh.on('end', () => dropped(fresh));
    try {
      await fresh.connect();
      await fresh.query(`LISTEN ${TEAM_ANSWERS_CHANNEL}`);
    } catch (error) {
      fresh.end().catch(() => undefined);
      throw error;
    }
    live = fresh;
    // Whatever was kept before this connection could have changed unheard.
    options.lost();
  }

  return {
    ready() {
      if (live !== null) return Promise.resolve();
      connecting ??= connect().catch((error: unknown) => {
        connecting = null;
        throw error;
      });
      return connecting;
    },
    async close() {
      const ending = live;
      live = null;
      connecting = null;
      await ending?.end().catch(() => undefined);
    },
  };
}
