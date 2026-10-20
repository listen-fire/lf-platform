// The "Listen-Fire" Slack app's inbound Events door — the single global entry for the
// movements app, which is installed per workspace (one Events URL for the app,
// all installs deliver here). Distinct from the BYO webhook_sync door (per
// subscription URL): routing is by the Slack workspace (`team_id`).
//
//   inbound event  →  team_id  →  the app_id='listen-fire' SLACK credential whose
//   identifier is `teamId:<team_id>`  →  that credential's Listen-Fire team + token
//   →  dispatch the team's Slack movements (which reply via that install).
//
// A workspace with no Slack credential (not installed / uninstalled) is dropped.
//
// The door only writes the delivery down (`enqueueSlackEvent`); the routing and
// dispatch below run when its `slack_event` row drains. They make live Slack
// reads (the channel and actor filters), which can outlast Slack's 3 s ack
// budget, and work done after the answer is lost to a restart or a frozen
// instance.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { WorkHandler } from '../work/kinds';

import { registerWorkKinds } from '../work/drain';
import { enqueueWork } from '../work/store';
import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import { parseSlackEvents } from './providers/slack';
import { dispatchToProviderTriggers } from './handler';
import { enqueueAwaitWakes } from '../movement_engine/await_wake';
import { teamIdSchema } from '../../lib/team_id';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { SLACK_ADAPTER_TYPE, slackEventToDiscriminable } from '../translation_graph/adapters/slack';
import { SLACK_APP_ID } from '../credentials/app_id';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';

/** The provider key SLACK triggers are routed by (= `trigger.kind`). */
const SLACK_PROVIDER_KEY = 'SLACK';

export interface SlackEventsResult {
  ok: boolean;
  classification: 'dispatched' | 'no_events' | 'unknown_workspace' | 'no_team';
  /** The Slack workspace id the delivery was for, when present. */
  teamId?: string;
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
 * Routes by the envelope `team_id` to the workspace's install, then dispatches
 * each event through the shared trigger fan-out with that install's credential
 * (so trigger matching + the reply both use the right token). url_verification
 * is handled at the route before this runs.
 *
 * Runs as a drained `slack_event` row. A wake or dispatch that failed is logged
 * and the rest still run; then it throws, so the row retries the whole delivery,
 * which the receipts make safe (an event already captured is a duplicate).
 */
export async function handleSlackEventsInbound(raw: unknown): Promise<SlackEventsResult> {
  const teamId = (raw as { team_id?: unknown } | null | undefined)?.team_id;
  if (typeof teamId !== 'string' || teamId.length === 0) {
    return { ok: true, classification: 'no_team' };
  }

  const events = parseSlackEvents(raw);
  if (events.length === 0) {
    return { ok: true, classification: 'no_events', teamId };
  }

  const install = await resolveSlackInstall(teamId);
  if (!install) {
    logger.info('[SlackEvents] no Listen-Fire install for workspace — ignoring', { teamId });
    return { ok: true, classification: 'unknown_workspace', teamId };
  }

  const failures: string[] = [];

  // The wake door, independent of dispatch below (consent-by-silence, S18).
  const nativeTeamId = install.nativeTeamId;
  try {
    const adapter = await resolveAdapter({
      adapterType: SLACK_ADAPTER_TYPE,
      teamId: nativeTeamId,
      credentialsId: install.credentialsId,
    });
    if (adapter.wakeKeys) {
      await enqueueAwaitWakes({
        adapterType: adapter.adapterType,
        teamId: nativeTeamId,
        correlationKeys: await adapter.wakeKeys({ raw }),
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('[SlackEvents] await wake failed', { teamId, error });
    failures.push(`wake: ${error}`);
  }

  let processed = 0;
  for (const event of events) {
    try {
      await dispatchToProviderTriggers({
        // The shared Slack mapper stamps `changeType: 'create'` on message
        // deliveries — what routes the seed onto the EVENT node (`Message
        // Received`). Reactions carry none and keep their legacy seed.
        event: slackEventToDiscriminable(event),
        // The install's credential is BOTH the trigger-matching key and the send
        // identity — a real BYO-style dispatch (no matchAnyCredential), so a
        // team's Slack movement fires and replies via its own workspace token.
        subscription: {
          team_id: install.nativeTeamId,
          credentials_id: install.credentialsId,
          provider: SLACK_PROVIDER_KEY,
        },
        adapterType: SLACK_ADAPTER_TYPE,
      });
      processed += 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('[SlackEvents] dispatch failed', { teamId, error });
      failures.push(`dispatch: ${error}`);
    }
  }
  if (failures.length > 0) throw new Error(`Slack delivery for ${teamId} incomplete (${failures.join('; ')})`);

  return { ok: true, classification: 'dispatched', teamId, eventsProcessed: processed };
}

declare module '../work/kinds' {
  interface UnitWorkKinds {
    slack_event: true;
  }
}

const slackEventPayloadSchema = z.object({ envelope: z.unknown() });

const slackEventIdSchema = z.object({ event_id: z.string().min(1) });

/**
 * The door's whole job inside Slack's ack budget: the delivery, durably, as one
 * `slack_event` row. Keyed on Slack's envelope `event_id`, which is stable
 * across Slack's retries, so a retry that lands while the row still waits folds
 * onto it. A retry that lands after the row ran runs the delivery again and
 * finds every trigger receipt already stored under the same id, so nothing
 * dispatches twice. A delivery without an `event_id` is keyed on its bytes.
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
