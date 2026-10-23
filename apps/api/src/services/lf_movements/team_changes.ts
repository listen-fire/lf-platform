// Hearing that a team's served movements may have changed: Postgres LISTEN on
// the team's own channel, which the database's triggers NOTIFY on a write that
// can change what lf is served (schema.sql, `automations.lf_movements_notify`).
// A NOTIFY reaches every listening connection, so a write through any api
// instance wakes a watch held by any other.
//
// One connection per process carries every team's channel, open while at least
// one watch is held and closed when the last one ends; a held watch is never
// a connection of its own. A dropped connection wakes every waiter as `lost`:
// their LISTEN went with it, so each one subscribes again (a new connection)
// after re-listing, rather than waiting on a channel nobody hears.

import { Client } from 'pg';
import { logger } from 'movement-engine/public/log';

const CLIENT_KEEPALIVE_DELAY_MS = 30_000;

/** What a held watch waits on: `changed` when the team's channel was notified
 *  (since subscribing, or since the last wait), `lost` when the connection
 *  dropped, `quiet` when the time ran out first. */
export type TeamChangeWake = 'changed' | 'lost' | 'quiet';

export interface TeamChangeSubscription {
  /** Waits up to `ms` for the team's channel. A notification that arrived
   *  since the last wait answers at once. */
  next(ms: number): Promise<TeamChangeWake>;
  close(): Promise<void>;
}

export interface TeamChanges {
  /** Resolves once the team's channel is listened on: a write committed after
   *  that is never missed. */
  subscribe(teamId: string): Promise<TeamChangeSubscription>;
  /** Ends the connection (a test's teardown; the server holds it for good). */
  close(): Promise<void>;
}

/** The channel the triggers notify for a team: the id's hex digits, as
 *  `replace(team_id::text, '-', '')` writes them. */
export function teamChannel(teamId: string): string {
  const hex = teamId.toLowerCase().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('a team id is a uuid');
  return `lf_movements_${hex}`;
}

interface Waiter {
  pending: TeamChangeWake | null;
  wake: ((wake: TeamChangeWake) => void) | null;
}

function signal(waiter: Waiter, wake: TeamChangeWake): void {
  // A loss outranks a change: the waiter must subscribe again either way.
  if (waiter.pending !== 'lost') waiter.pending = wake;
  waiter.wake?.(waiter.pending);
}

/** Listens over its own connection to `connectionString`. */
export function postgresTeamChanges(connectionString: string): TeamChanges {
  let client: Promise<Client> | null = null;
  let live: Client | null = null;
  /** Channel → the waiters on it, and the LISTEN that made it heard. */
  const channels = new Map<string, { waiters: Set<Waiter>; listened: Promise<unknown> }>();

  function dropped(from: Client, error?: unknown): void {
    if (live !== from) return;
    live = null;
    client = null;
    const waiters = [...channels.values()].flatMap((channel) => [...channel.waiters]);
    channels.clear();
    if (error !== undefined) {
      logger.warn('[lf-movements] watch: the change connection dropped', {
        error: error instanceof Error ? error.message : String(error),
        waiters: waiters.length,
      });
    }
    for (const waiter of waiters) signal(waiter, 'lost');
    from.end().catch(() => undefined);
  }

  function connected(): Promise<Client> {
    if (client !== null) return client;
    const fresh = new Client({ connectionString, keepAlive: true, keepAliveInitialDelayMillis: CLIENT_KEEPALIVE_DELAY_MS });
    fresh.on('notification', (message) => {
      for (const waiter of channels.get(message.channel)?.waiters ?? []) signal(waiter, 'changed');
    });
    fresh.on('error', (error) => dropped(fresh, error));
    fresh.on('end', () => dropped(fresh));
    live = fresh;
    client = fresh.connect().then(
      () => fresh,
      (error: unknown) => {
        if (live === fresh) {
          live = null;
          client = null;
        }
        throw error;
      },
    );
    return client;
  }

  async function release(channel: string, waiter: Waiter): Promise<void> {
    const entry = channels.get(channel);
    if (entry === undefined || !entry.waiters.delete(waiter) || entry.waiters.size > 0) return;
    channels.delete(channel);
    if (channels.size === 0 && live !== null) {
      const ending = live;
      live = null;
      client = null;
      await ending.end().catch(() => undefined);
      return;
    }
    await live?.query(`UNLISTEN "${channel}"`).catch(() => undefined);
  }

  return {
    async subscribe(teamId) {
      const channel = teamChannel(teamId);
      const waiter: Waiter = { pending: null, wake: null };
      let pg = await connected();
      // The last waiter of another team may have closed this connection while
      // it was being awaited: take the next one.
      while (pg !== live) pg = await connected();
      let entry = channels.get(channel);
      if (entry === undefined) {
        entry = { waiters: new Set(), listened: pg.query(`LISTEN "${channel}"`) };
        channels.set(channel, entry);
      }
      entry.waiters.add(waiter);
      try {
        await entry.listened;
      } catch (error) {
        await release(channel, waiter);
        throw error;
      }
      return {
        next(ms) {
          if (waiter.pending !== null) {
            const wake = waiter.pending;
            if (wake !== 'lost') waiter.pending = null;
            return Promise.resolve(wake);
          }
          return new Promise<TeamChangeWake>((resolve) => {
            const timer = setTimeout(() => finish('quiet'), Math.max(0, ms));
            function finish(wake: TeamChangeWake) {
              clearTimeout(timer);
              waiter.wake = null;
              if (wake !== 'lost') waiter.pending = null;
              resolve(wake);
            }
            waiter.wake = finish;
          });
        },
        close: () => release(channel, waiter),
      };
    },
    async close() {
      const ending = live;
      live = null;
      client = null;
      channels.clear();
      await ending?.end().catch(() => undefined);
    },
  };
}
