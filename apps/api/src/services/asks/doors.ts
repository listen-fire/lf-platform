// The platform's doors onto an ask: every way a person (or the system that
// asked) answers or cancels one OUTSIDE movement code —
//   • the link page      — a confirmed POST on `/api/asks/<token>`
//   • Slack / Telegram   — a block-action / callback-query POST
//   • the agent (MCP)    — an answer against an ask id
//   • the control tower  — an operator answering on a person's behalf
//   • the REST API       — `POST /v1/asks/:id/cancel`
// and the REST API's create (`POST /v1/asks`), the one way to raise an ask
// outside a movement. Each finds the ask's team, then answers through the `@lf/ask` module over
// that team's records — the same function a movement's `write a-[:Response]->`
// reaches — so there is one answer semantics, and the settle wakes whoever
// waits from one place (the asks table's kv, `store.ts`).
//
// GET never writes ANYWHERE: these are only ever reached from a POST /
// block-action / authed call. A `?answer=` query param PRE-FILLS a control; it
// never resolves.

import type { AskId } from '../../generated/kysely/asks/Ask';
import type { TeamId } from '../../generated/kysely/core/Team';

import { answerAsk, cancelAsk, createAsk as createModuleAsk, type AskOutcome, type CreateAskInput } from '@listen-fire/ask';
import { getAsk, lookupAskByToken, platformAskRecords, platformView, type AskRecord } from './store';

export { AskResponseRefused } from '@listen-fire/ask';

export type AskDoorOutcome =
  /** The token is not an ask's — the caller should fall through to the
   *  legacy path (link page only; other callers treat it as not-found). */
  | { kind: 'not_ours' }
  /** No such ask (a bad id / a token whose ask is gone). */
  | { kind: 'not_found' }
  /** Answered just now — the run (if any) will resume. */
  | { kind: 'answered'; ask: AskRecord }
  /** Already settled (answered elsewhere / cancelled) or the token has lapsed —
   *  closed-request-wins: whoever raced sees the terminal state, nothing moves. */
  | { kind: 'closed'; ask: AskRecord }
  /** The submitted value did not fit the family's answer type. */
  | { kind: 'invalid'; message: string; ask: AskRecord };

/**
 * Raise an ask for a team outside movement code. `callbackUrl` is where the
 * creator is told when it settles (the standalone deployment's signed
 * webhook); the module never sees it.
 */
export async function createAsk(
  input: CreateAskInput & { teamId: TeamId; callbackUrl?: string | null },
): Promise<AskRecord> {
  const { teamId, callbackUrl, ...spec } = input;
  const raised = await createModuleAsk(platformAskRecords(teamId, { callbackUrl: callbackUrl ?? null }), spec);
  return platformView(raised, { teamId, callbackUrl: callbackUrl ?? null });
}

/** The module's outcome, with the platform's view of the record: `held` is
 *  the ask as the door found it, which says whose it is. */
function doorOutcome(outcome: AskOutcome, held: AskRecord): AskDoorOutcome {
  if (outcome.kind === 'not_found') return { kind: 'not_found' };
  const ask = platformView(outcome.ask, held);
  switch (outcome.kind) {
    case 'settled':
      return { kind: 'answered', ask };
    case 'closed':
      return { kind: 'closed', ask };
    case 'invalid':
      return { kind: 'invalid', message: outcome.message, ask };
  }
}

async function answer(ask: AskRecord, raw: unknown): Promise<AskDoorOutcome> {
  return doorOutcome(await answerAsk(platformAskRecords(ask.teamId), { id: ask.id, raw }), ask);
}

/** Answer by capability token — the link page and the chat doors. Returns
 *  `not_ours` when the token is not an ask's, so the link page can hand off
 *  to the legacy resolver. */
export async function answerAskByToken(token: string, raw: unknown): Promise<AskDoorOutcome> {
  const ask = await lookupAskByToken(token);
  if (!ask) return { kind: 'not_ours' };
  return answer(ask, raw);
}

/** Answer by ask id — the agent (MCP) and the control tower. Returns
 *  `not_found` for an id the platform does not hold. */
export async function answerAskById(askId: AskId, raw: unknown): Promise<AskDoorOutcome> {
  const ask = await getAsk(askId);
  if (!ask) return { kind: 'not_found' };
  return answer(ask, raw);
}

export type CancelOutcome =
  | { ok: true; ask: AskRecord }
  | { ok: false; reason: 'not_found' | 'settled'; ask?: AskRecord };

/**
 * Cancel an open ask — the REST API's cancel and the withdrawal of an await
 * nobody will consume. A run parked on the ask is woken and its await resolves
 * empty; a cancel is not an answer, so the creator's settle webhook stays the
 * answer's alone (`notifier.ts`).
 */
export async function cancelAskAndWake(input: { id: AskId }): Promise<CancelOutcome> {
  const ask = await getAsk(input.id);
  if (!ask) return { ok: false, reason: 'not_found' };
  const outcome = doorOutcome(await cancelAsk(platformAskRecords(ask.teamId), { id: ask.id }), ask);
  switch (outcome.kind) {
    case 'answered':
      return { ok: true, ask: outcome.ask };
    case 'closed':
    case 'invalid':
      return { ok: false, reason: 'settled', ask: outcome.ask };
    case 'not_found':
    case 'not_ours':
      return { ok: false, reason: 'not_found' };
  }
}
