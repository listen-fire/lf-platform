// Shared built-in Telegram bot — the SINGLE global inbound entry.
//
// Unlike BYO Telegram (one webhook subscription per team, the team implied by
// the subscription row in the URL), the shared bot is ONE bot serving every
// team. There is no per-team subscription URL; routing is by SENDER IDENTITY:
//
//   1. `/start <token>` — the deep-link handshake. The ONLY action an UNLINKED
//      user may drive. Bind the real Telegram account to the minting user's
//      Listen-Fire identity (`bindTelegramFromStart`), then reply through the
//      built-in bot ("✅ Linked, <name>." / a friendly reject). Done.
//
//   2. A message from a LINKED sender. Resolve `telegram_user_id` → EVERY
//      `adapters.telegram_identity` row with that id → the set of `(team_id)`
//      bindings (a user may be linked in several teams). For each such team,
//      the module's arrivals are kept as a delivery of the shared bot, judged
//      by every Telegram listen of that team (inbound/listen_door.ts), run AS
//      that user (the per-team `extractActor` resolves the binding within its
//      own team → the team-clamped `lookupTeamUserByEmail` → ActingUser).
//      Route-all across teams.
//
// KEEP-THEN-ACK. Telegram redelivers anything it doesn't get a prompt 2xx
// for, so the movement must not run inside the request. Each team's delivery
// is kept pre-ack, with a `fire_event` row per run it starts; the movement runs
// when the row drains. `/start` stays wholly pre-ack — see `handleStart`.
//
//   3. An UNLINKED sender (no identity row) that isn't `/start` → ignore
//      silently (the spam gate). A reply-to-bot → classified but no-op in v1.
//
// SECURITY INVARIANTS (Pillar B0 + C):
//   • A team only ever sees a message from a user IT has a binding for — the
//     `telegram_identity` rows ARE the gate. We fan out to exactly the teams
//     whose rows match the sender; a team with no row never receives the event.
//   • The adapter never picks the team — the binding rows do. The adapter only
//     asserts "this is person E"; the framework owns team-routing.
//   • The downstream `lookupTeamUserByEmail` clamp (`u.team_id = teamId`) stays
//     in force: the per-team `extractActor` resolves the binding scoped to that
//     team, so a resolved email can only ever match a user in the SAME team.

import type { TeamId } from '../../generated/kysely/core/Team';
import type { WebhookEvent } from './providers';
import type { HarnessDelivery } from '../work/harness';

import { getAutomationsQb } from '../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import {
  parseTelegramEvents,
} from '../translation_graph/adapters/telegram';
import { deliverArrivals } from '../inbound/listen_door';
import { capturedRequest } from '../inbound/captured_request';
import { builtinModuleRequestKeeping } from '../translation_graph/adapters/builtin_modules';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { notifyWork } from '../work/drain';
import { isTestHarnessTeam } from '../../lib/recording';
import {
  TELEGRAM_ADAPTER_TYPE,
  TelegramAdapter,
} from '../translation_graph/adapters/telegram';
import { bindTelegramFromStart } from '../translation_graph/adapters/telegram/handshake';
import { handleTelegramCallbackQuery, ownsCallbackQuery } from './telegram_callback_door';

/** The subscription the shared bot's deliveries are kept under. */
const TELEGRAM_PROVIDER_KEY = 'TELEGRAM';

/** A parsed shared-bot inbound `Update`, classified for routing. */
type SharedBotInbound =
  | { kind: 'start'; token: string; telegramUserId: string; chatId: string; senderName?: string }
  | { kind: 'message'; telegramUserId: string; event: WebhookEvent }
  | { kind: 'callback_query' }
  | { kind: 'reply_to_bot' }
  | { kind: 'ignore' };

export interface SharedBotResult {
  ok: boolean;
  /** Coarse classification of what the inbound was — surfaced for the dev loop.
   *  `unauthorized` is produced by the route's secret-token gate (the request
   *  could not be proven to come from Telegram) BEFORE this service runs. */
  classification:
    | 'start'
    | 'message'
    | 'callback_query'
    | 'reply_to_bot'
    | 'unlinked_ignore'
    | 'no_message'
    | 'unauthorized';
  /** For `/start`: whether the bind succeeded + the reject reason if not. */
  bind?: { ok: boolean; reason?: string; email?: string };
  /** For a button tap: how the answer door settled it. */
  callback?: { handled: boolean; outcome?: string };
  /** For a linked message: the teams whose delivery was kept. */
  routedTeamIds?: string[];
  error?: string;
}

/**
 * One shared-bot delivery, split around the ack.
 *
 * `result` is everything settled before any movement runs — the body the door
 * answers Telegram with. `enqueueDeferred` queues the movement runs, which the
 * door awaits before its 200.
 */
export interface SharedBotDelivery {
  result: SharedBotResult;
  /**
   * Pokes the drain to start the runs each team's kept delivery queued. Absent
   * when the delivery carried nothing to run (`/start`, an ignore, an unlinked
   * sender). A team whose delivery failed is logged and left out of
   * `routedTeamIds`; the caller still guards an unexpected throw.
   */
  enqueueDeferred?: () => Promise<EnqueuedSharedBotDelivery>;
  /**
   * Test-harness deliveries drain the rows before acking, so `pnpm dev:inject
   * telegram-builtin` keeps seeing the run happen synchronously (and dispatch
   * errors surfaced) the way it always has.
   */
  awaitDeferred?: boolean;
}

/** What `enqueueDeferred` queued; `readOutcome` once the rows have drained. */
export type EnqueuedSharedBotDelivery = HarnessDelivery<SharedBotResult>;

/**
 * Resolve the team used purely to construct the built-in client for the
 * `/start` confirmation reply. The built-in bot token is env-global, so the
 * team only governs the fake-base-url swap under the dev loop. We use the
 * test-harness team when set (so the reply lands in the fake outbox), else a
 * synthetic id (the real Telegram host applies in production).
 */
function replyClientTeamId(): TeamId {
  const harness = process.env.TEST_HARNESS_TEAM_ID;
  return ((harness && harness.length > 0 ? harness : 'shared-telegram-bot') as unknown) as TeamId;
}

/**
 * Parse + classify a raw shared-bot `Update`. The classification picks the
 * route; the heavy lifting (binding, fan-out) happens in the entry below.
 *
 * `/start <token>` is detected on the raw message text BEFORE the provider's
 * `parseEvents` (which is the per-message normaliser) — a `/start` is a control
 * command, not a movement-bearing message.
 */
export function classifySharedBotInbound(raw: unknown): SharedBotInbound {
  // A button tap is a `callback_query`, never a `message` — classify it first
  // so it can never be mistaken for one, and so nothing downstream of the
  // message path has to know it exists.
  if (ownsCallbackQuery(raw)) return { kind: 'callback_query' };

  const update = (raw ?? {}) as {
    message?: {
      text?: string;
      from?: { id?: number | string; first_name?: string; username?: string; is_bot?: boolean };
      chat?: { id?: number | string };
      reply_to_message?: { from?: { is_bot?: boolean } };
    };
  };
  const message = update.message;
  if (!message || !message.from) return { kind: 'ignore' };

  const telegramUserId = String(message.from.id ?? '');
  if (telegramUserId.length === 0) return { kind: 'ignore' };

  // A reply to one of OUR bot's messages — classified, but no-op in v1.
  if (message.reply_to_message?.from?.is_bot === true) {
    return { kind: 'reply_to_bot' };
  }

  // `/start <token>` — the handshake. `/start` with no token is a plain greet
  // (no binding to do) → fall through to the message path (which ignores it if
  // the sender is unlinked).
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const startMatch = /^\/start(?:@\w+)?\s+(\S+)/.exec(text);
  if (startMatch) {
    return {
      kind: 'start',
      token: startMatch[1],
      telegramUserId,
      chatId: String(message.chat?.id ?? ''),
      senderName: message.from.first_name ?? message.from.username,
    };
  }

  // A normal message. Re-use the adapter's pure parse so the event payload is
  // byte-identical to the BYO door (whose `preprocessInbound` runs the same
  // function — the adapter reads `chat_id`/`text`/`sender_*` off `data`).
  const events = parseTelegramEvents(raw);
  if (events.length === 0) return { kind: 'ignore' };
  return { kind: 'message', telegramUserId, event: events[0] };
}

/**
 * Every team that has a binding for this Telegram user. The identity rows are
 * the routing gate: each `(team_id, telegram_user_id, email)` row means that
 * team consented (via the authenticated handshake) to receive this sender's
 * messages. A team with no row is never returned — structural isolation.
 */
async function teamsForTelegramUser(telegramUserId: string): Promise<string[]> {
  const rows = await getAutomationsQb(['telegram_identity'])
    .selectFrom('telegram_identity')
    .where('telegram_user_id', '=', telegramUserId)
    .select(['team_id'])
    .execute();
  // De-dupe defensively (UNIQUE(team_id, telegram_user_id) already guarantees
  // one row per team, but distinct teams are what we fan out over).
  return Array.from(new Set(rows.map((r) => r.team_id as string)));
}

/**
 * The shared-bot inbound entry. ONE global call per delivered `Update`;
 * performs the identity-based fan-out (or the `/start` handshake) instead of
 * the per-subscription single-team dispatch. BYO inbound is untouched — it
 * still flows through `handleInboundWebhook` keyed by its subscription row.
 *
 */
export async function handleSharedBotInbound(raw: unknown): Promise<SharedBotDelivery> {
  const inbound = classifySharedBotInbound(raw);

  if (inbound.kind === 'ignore') {
    return { result: { ok: true, classification: 'no_message' } };
  }

  if (inbound.kind === 'callback_query') {
    // Wholly pre-ack, like `/start`: settling the question is one DB write and
    // two Bot API calls, and the tapper's client spins until the first of them
    // lands. The run parked on the question resumes on its own.
    const result = await handleTelegramCallbackQuery({
      raw,
      responder: new TelegramAdapter(replyClientTeamId()),
    });
    return {
      result: {
        ok: true,
        classification: 'callback_query',
        callback: { handled: result.handled, ...(result.outcome ? { outcome: result.outcome } : {}) },
      },
    };
  }

  if (inbound.kind === 'reply_to_bot') {
    // v1: classify but no-op. Reply-threading / run-resume is phase 2.
    logger.info('[TelegramSharedBot] reply-to-bot — no-op in v1');
    return { result: { ok: true, classification: 'reply_to_bot' } };
  }

  if (inbound.kind === 'start') {
    // Wholly pre-ack: the bind is a single locked DB write and the confirmation
    // reply is one Bot API call. Neither is a movement run, and the bind result
    // IS the response body — deferring would ack an outcome we don't have yet.
    return { result: await handleStart(inbound) };
  }

  // A normal message from a (maybe) linked sender.
  const teamIds = await teamsForTelegramUser(inbound.telegramUserId);
  if (teamIds.length === 0) {
    // Unlinked sender + not `/start` → ignore silently (the spam gate).
    logger.info('[TelegramSharedBot] unlinked sender — ignoring', {
      telegramUserId: inbound.telegramUserId,
    });
    return { result: { ok: true, classification: 'unlinked_ignore' } };
  }

  // Route-all: the SAME arrivals kept for every team that has a binding for
  // this sender. Each team is independent; one team's failure doesn't abort
  // the others. The shared bot received this globally, so the delivery is the
  // bot's install's: every Telegram listen of the team judges it, whatever
  // connection it names (the binding rows are the gate, not a credential).
  const delivered: string[] = [];
  for (const teamId of teamIds) {
    try {
      const adapter = await resolveAdapter({ adapterType: TELEGRAM_ADAPTER_TYPE, teamId: teamId as TeamId });
      if (adapter.preprocessInbound === undefined) throw new Error('the Telegram module reads no inbound updates (preprocessInbound)');
      const { arrivals = [] } = await adapter.preprocessInbound({ raw });
      if (arrivals.length === 0) continue;
      const { kept } = await deliverArrivals({
        teamId: teamId as TeamId,
        delivered: { adapterType: TELEGRAM_ADAPTER_TYPE, credentialsId: null },
        subscriptionId: TELEGRAM_PROVIDER_KEY,
        externalId: updateIdOf(raw),
        source: 'webhook',
        arrivals,
        // The update as Telegram sent it, so a listen can be put through it
        // again (listen_replay.ts).
        request: capturedRequest({
          keeping: builtinModuleRequestKeeping(TELEGRAM_ADAPTER_TYPE),
          headers: { 'content-type': 'application/json' },
          rawBody: Buffer.from(JSON.stringify(raw), 'utf8'),
          arrivals,
        }),
      });
      if (kept.kept) delivered.push(teamId);
    } catch (err) {
      logger.error('[TelegramSharedBot] keeping the delivery failed for team', {
        teamId,
        telegramUserId: inbound.telegramUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const result: SharedBotResult = { ok: true, classification: 'message', routedTeamIds: delivered };
  return {
    result,
    // The runs are queued with the deliveries; the drain is poked to take them.
    enqueueDeferred: async () => {
      notifyWork();
      return { teamIds: delivered, readOutcome: async () => result };
    },
    ...(teamIds.some(isTestHarnessTeam) ? { awaitDeferred: true } : {}),
  };
}

/** Telegram's `update_id`, which its redeliveries keep: a redelivery of an
 *  update keeps nothing twice. */
function updateIdOf(raw: unknown): string | null {
  const id = (raw as { update_id?: unknown } | null | undefined)?.update_id;
  return typeof id === 'number' || typeof id === 'string' ? `telegram:${id}` : null;
}

/**
 * The `/start <token>` handshake half. Validates + consumes the token, writes
 * the identity binding, and replies through the built-in bot. The reply is
 * best-effort: a send failure (e.g. no `TELEGRAM_BOT_TOKEN`) doesn't undo a
 * successful bind — the bind is the durable, security-relevant act.
 */
async function handleStart(
  inbound: Extract<SharedBotInbound, { kind: 'start' }>,
): Promise<SharedBotResult> {
  const result = await bindTelegramFromStart({
    token: inbound.token,
    telegramUserId: inbound.telegramUserId,
  });

  const reply = result.ok
    ? `✅ Linked, ${inbound.senderName ?? 'there'}. Your Telegram is now connected to Listen-Fire.`
    : rejectMessage(result.reason);

  if (inbound.chatId.length > 0) {
    try {
      const adapter = new TelegramAdapter(replyClientTeamId());
      await adapter.sendBuiltInReply({ chatId: inbound.chatId, text: reply });
    } catch (err) {
      logger.warn('[TelegramSharedBot] handshake reply send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    classification: 'start',
    bind: result.ok
      ? { ok: true, email: result.email }
      : { ok: false, reason: result.reason },
  };
}

/** A friendly, non-leaky reject for a failed `/start`. */
function rejectMessage(reason: string): string {
  switch (reason) {
    case 'token_expired':
      return '⚠️ That link has expired. Open Listen-Fire and click "Connect Telegram" again for a fresh link.';
    case 'token_used':
      return '⚠️ That link was already used. Generate a new one from Listen-Fire if you need to re-link.';
    case 'token_not_found':
      return '⚠️ That link is not valid. Start from the "Connect Telegram" button in Listen-Fire.';
    case 'no_primary_email':
      return '⚠️ We could not find an email on your Listen-Fire account to link. Contact support.';
    default:
      return '⚠️ We could not complete linking. Please try again from Listen-Fire.';
  }
}
