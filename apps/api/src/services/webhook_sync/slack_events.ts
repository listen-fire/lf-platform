// The "Listen-Fire" Slack app's inbound Events door — the single global entry for the
// movements app, which is installed per workspace (one Events URL for the app,
// all installs deliver here). Distinct from the BYO webhook_sync door (per
// subscription URL): routing is by the Slack workspace (`team_id`).
//
//   inbound event  →  team_id  →  the app_id='listen-fire' SLACK credential whose
//   identifier is `teamId:<team_id>`  →  that credential's Listen-Fire team + token
//   →  the module's arrivals, judged by the team's Slack listens on that
//   connection (which reply via that install), and the waits on each record woken.
//
// A workspace with no Slack credential (not installed / uninstalled) is dropped.
//
// The door only writes the delivery down (`enqueueSlackEvent`); the routing and
// judging below run when its `slack_event` row drains. Reading the arrivals
// makes live Slack reads (a channel's name, the bot's own id), which can
// outlast Slack's 3 s ack budget, and work done after the answer is lost to a
// restart or a frozen instance.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { WorkHandler } from '../work/kinds';

import { notifyWork, registerWorkKinds } from '../work/drain';
import { enqueueWork } from '../work/store';
import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import { teamIdSchema } from '../../lib/team_id';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { SLACK_ADAPTER_TYPE } from '../translation_graph/adapters/slack';
import { deliverArrivals } from '../inbound/listen_door';
import { capturedRequest } from '../inbound/captured_request';
import { builtinModuleRequestKeeping } from '../translation_graph/adapters/builtin_modules';
import { SLACK_APP_ID } from '../credentials/app_id';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';

/** The subscription the app's deliveries are kept under. */
const SLACK_PROVIDER_KEY = 'SLACK';

export interface SlackEventsResult {
  ok: boolean;
  classification: 'dispatched' | 'no_events' | 'unknown_workspace' | 'no_team';
  /** The Slack workspace id the delivery was for, when present. */
  teamId?: string;
  /** The runs the delivery queued. */
  eventsProcessed?: number;
}

/**
 * Resolve a Slack workspace id → the Listen-Fire install for it: the `SLACK`
 * credential stamped `app_id='listen-fire'` whose `identifier` is `teamId:<id>`. The
 * credential row carries the Listen-Fire team + is the send identity (its token).
 */
async function resolveSlackInstall(
  slackTeamId: string,
): Promise<{ credentialsId: string; nativeTeamId: TeamId } | null> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('type', '=', ExternalServiceType.SLACK)
    .where('app_id', '=', SLACK_APP_ID.movements)
    .where('identifier', '=', `teamId:${slackTeamId}`)
    .select(['id', 'team_id'])
    .executeTakeFirst();
  if (!row) return null;
  return { credentialsId: row.id as unknown as string, nativeTeamId: teamIdSchema.parse(row.team_id) };
}

/**
 * The Listen-Fire-app inbound entry. ONE global call per delivered `event_callback`.
 * Routes by the envelope `team_id` to the workspace's install, reads the
 * delivery's arrivals with that install's credential, and keeps them as one
 * delivery of that connection: judged by the team's Slack listens on it, the
 * waits parked on each record woken. url_verification is handled at the route
 * before this runs.
 *
 * Runs as a drained `slack_event` row; a failure throws, so the row retries the
 * whole delivery, which its external id (Slack's `event_id`) makes safe.
 */
export async function handleSlackEventsInbound(raw: unknown): Promise<SlackEventsResult> {
  const teamId = (raw as { team_id?: unknown } | null | undefined)?.team_id;
  if (typeof teamId !== 'string' || teamId.length === 0) {
    return { ok: true, classification: 'no_team' };
  }

  const install = await resolveSlackInstall(teamId);
  if (!install) {
    logger.info('[SlackEvents] no Listen-Fire install for workspace — ignoring', { teamId });
    return { ok: true, classification: 'unknown_workspace', teamId };
  }

  const adapter = await resolveAdapter({
    adapterType: SLACK_ADAPTER_TYPE,
    teamId: install.nativeTeamId,
    credentialsId: install.credentialsId,
  });
  if (adapter.preprocessInbound === undefined) throw new Error('the Slack module reads no inbound deliveries (preprocessInbound)');
  const { arrivals = [] } = await adapter.preprocessInbound({ raw });
  if (arrivals.length === 0) return { ok: true, classification: 'no_events', teamId };

  const eventId = slackEventIdSchema.safeParse(raw);
  const { kept, fires } = await deliverArrivals({
    teamId: install.nativeTeamId,
    delivered: { adapterType: SLACK_ADAPTER_TYPE, credentialsId: install.credentialsId },
    subscriptionId: SLACK_PROVIDER_KEY,
    externalId: eventId.success ? `slack:${eventId.data.event_id}` : null,
    source: 'webhook',
    arrivals,
    // Kept as Slack sent it, as JSON, so a listen can be put through it again
    // (listen_replay.ts); the work row keeps the envelope, not its bytes.
    request: capturedRequest({
      keeping: builtinModuleRequestKeeping(SLACK_ADAPTER_TYPE),
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(JSON.stringify(raw), 'utf8'),
      arrivals,
    }),
  });
  if (kept.kept) notifyWork();
  return { ok: true, classification: 'dispatched', teamId, eventsProcessed: kept.kept ? fires.length : 0 };
}

declare module '../work/kinds' {
  interface UnitWorkKinds {
    slack_event: true;
  }
}

const slackEventPayloadSchema = z.object({ envelope: z.unknown().optional() });

const slackEventIdSchema = z.object({ event_id: z.string().min(1) });

/**
 * The door's whole job inside Slack's ack budget: the delivery, durably, as one
 * `slack_event` row. Keyed on Slack's envelope `event_id`, which is stable
 * across Slack's retries, so a retry that lands while the row still waits folds
 * onto it. A retry that lands after the row ran keeps nothing: its delivery is
 * kept under the same id. A delivery without an `event_id` is keyed on its bytes.
 */
export async function enqueueSlackEvent(input: { envelope: unknown; rawBody: Buffer }): Promise<void> {
  const eventId = slackEventIdSchema.safeParse(input.envelope);
  const id = eventId.success ? eventId.data.event_id : createHash('sha256').update(input.rawBody).digest('hex');
  await enqueueWork({ kind: 'slack_event', key: `slack_event:${id}`, payload: { envelope: input.envelope } });
}

// A store outage backs a row off to minutes between attempts; past this many
// the delivery is given up on, loudly, rather than retried forever.
const MAX_SLACK_EVENT_ATTEMPTS = 10;

export const slackEventHandler: WorkHandler = {
  async run(payload, ctx) {
    const { envelope } = slackEventPayloadSchema.parse(payload);
    try {
      await handleSlackEventsInbound(envelope);
    } catch (error) {
      if (ctx.attempts < MAX_SLACK_EVENT_ATTEMPTS) throw error;
      logger.error('[SlackEvents] giving up on the delivery', {
        attempts: ctx.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

export function registerSlackEventWork(): void {
  registerWorkKinds([{ kind: 'slack_event', handler: slackEventHandler }]);
}
