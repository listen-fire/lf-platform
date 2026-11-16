// The one read of a delivery's kept request. A kept request may hold whatever
// the provider sent (a message's text, a person's address), so no list or
// replay ever returns it: only this read, asked for one delivery by someone who
// may use the connection it came for (the route decides that), and each read
// is recorded before it is answered.

import { TextDecoder } from 'node:util';

import { sql } from 'kysely';
import type { Arrival } from 'engine-contracts';

import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../lib/kysely';
import { readKeptRequest } from './captured_request';

/** Who asks: a person of the team, and the API key they came through. */
export interface RequestReader {
  userId: string;
  credentialId?: string;
}

export type ShownKept =
  | {
      kind: 'request';
      method: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      /** The body as text when it is UTF-8, else base64. */
      body: string;
      bodyEncoding: 'utf8' | 'base64';
      /** The arrivals it brought, by receipt key. */
      arrivalIds: string[];
    }
  | {
      /** What a poll or a door read itself: there was no request to keep. */
      kind: 'page';
      adapter: string;
      credential: string | null;
      arrivals: Arrival[];
    };

export type ShownRequest =
  | { outcome: 'refused'; reason: string }
  | { outcome: 'shown'; deliveryId: string; receivedAt: Date; source: string; replayOf: string | null; kept: ShownKept };

const utf8 = new TextDecoder('utf-8', { fatal: true });

function bodyOf(base64: string): { body: string; bodyEncoding: 'utf8' | 'base64' } {
  try {
    return { body: utf8.decode(Buffer.from(base64, 'base64')), bodyEncoding: 'utf8' };
  } catch {
    return { body: base64, bodyEncoding: 'base64' };
  }
}

/** The answer for a delivery the team does not have. */
export function noSuchDelivery(deliveryId: string): ShownRequest {
  return { outcome: 'refused', reason: `no delivery ${deliveryId} is kept for this team: a delivery past its retention is forgotten` };
}

/**
 * Show `deliveryId`'s kept request to `reader`, recording the read in the
 * same write. Refused, recording nothing, for a delivery the team does not
 * have or that kept no request.
 */
export async function showDeliveryRequest(input: { teamId: TeamId; deliveryId: string; reader: RequestReader }): Promise<ShownRequest> {
  const { teamId, deliveryId, reader } = input;
  return getAutomationsQb(['delivery', 'delivery_request_read']).transaction().execute(async (trx): Promise<ShownRequest> => {
    const { rows } = await sql<{ id: string; received_at: Date; source: string; replay_of: string | null; request: unknown }>`
      select id::text as id, received_at, source, replay_of::text as replay_of, request
      from automations.delivery
      where team_id = ${teamId}::uuid and id::text = ${deliveryId}::text`.execute(trx);
    const row = rows[0];
    if (row === undefined) return noSuchDelivery(deliveryId);
    if (row.request === null) {
      return {
        outcome: 'refused',
        reason:
          row.replay_of !== null
            ? `delivery ${row.id} is a replay of ${row.replay_of}: its request is ${row.replay_of}'s`
            : `delivery ${row.id} kept no request (it is past its retention, or was kept before deliveries kept theirs)`,
      };
    }
    const kept = readKeptRequest(row.request);
    if (kept === null) return { outcome: 'refused', reason: `delivery ${row.id}'s kept request is not one the platform can read` };
    await sql`
      insert into automations.delivery_request_read (team_id, delivery_id, read_by, credential_id)
      values (${teamId}::uuid, ${row.id}::uuid, ${reader.userId}::uuid, ${reader.credentialId ?? null})`.execute(trx);
    const shown: ShownKept =
      'page' in kept
        ? { kind: 'page', adapter: kept.page.adapter, credential: kept.page.credential ?? null, arrivals: kept.page.arrivals }
        : {
            kind: 'request',
            method: kept.request.method,
            path: kept.request.path,
            query: kept.request.query,
            headers: kept.request.headers,
            ...bodyOf(kept.request.body),
            arrivalIds: kept.request.arrivalIds ?? [],
          };
    return { outcome: 'shown', deliveryId: row.id, receivedAt: row.received_at, source: row.source, replayOf: row.replay_of, kept: shown };
  });
}
