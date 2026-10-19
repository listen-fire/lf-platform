// The ask records and their lattice, kept in the host's kv. Two keys per ask:
// `ask:<id>` holds the record, `token:<token>` names the ask its capability
// link answers. Every door an answer or a cancel arrives through — a
// movement's `write a-[:Response]->`, the host's link page, a chat button —
// ends in `answerAsk` or `cancelAsk` here, so the answer semantics live once.
//
// The lattice is `open → answered` and `open → expired`, both terminal.
// Expiry happens ONLY through the explicit cancel — never on a timer. Every
// write creates (no dedupe surface); provenance is information, never
// identity.
//
// Races: a transition writes only after reading `open`, and a host whose kv
// several processes share refuses a settle that another one beat (the
// platform's asks table guards on `state = 'open'`). Whoever loses re-reads
// the record and reports it closed: the first answer stands. A host that
// cannot refuse (one process, a file) has no second writer to race.

import { randomBytes, randomUUID } from 'node:crypto';

import type { ModuleKv } from 'module-kit';

import { coerceAnswer } from './answers';
import {
  ASK_TOKEN_PREFIX,
  askRecordSchema,
  type AskAnswerType,
  type AskFamily,
  type AskRecord,
  type AskRowSpec,
  type StoredAsk,
} from './types';

/** How long a per-ask capability token stays live. Long by design — the token
 *  is scoped to ONE ask, so a long window carries no cross-ask risk; the ask's
 *  own lattice, not the token TTL, is what closes it. */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const askKey = (id: string) => `ask:${id}`;
const tokenKey = (token: string) => `token:${token}`;

/** Where the host answers an ask: the link for a token. Absent on a host with
 *  no answer door, which then refuses to raise an ask. */
export type AnswerUrl = (token: string) => string;

/** The asks of one install, over its kv. */
export interface AskRecords {
  kv: ModuleKv;
  answerUrl: AnswerUrl;
}

function withUrl(stored: StoredAsk, answerUrl: AnswerUrl): AskRecord {
  return { ...stored, url: answerUrl(stored.token) };
}

export interface CreateAskInput {
  family: AskFamily;
  prompt: string;
  detail?: string | null;
  /** Provide only. */
  answerType?: AskAnswerType | null;
  /** Choose/Select: the offered options. Form: the named fields. */
  options?: string[] | null;
  /** Correct only. */
  rows?: AskRowSpec[] | null;
  provenance?: Record<string, unknown>;
}

export async function createAsk(records: AskRecords, input: CreateAskInput): Promise<AskRecord> {
  const now = new Date();
  const stored: StoredAsk = {
    id: randomUUID(),
    family: input.family,
    answerType: input.answerType ?? null,
    prompt: input.prompt,
    detail: input.detail ?? null,
    options: input.options ?? null,
    rows: input.rows ?? null,
    state: 'open',
    answer: null,
    token: ASK_TOKEN_PREFIX + randomBytes(24).toString('base64url'),
    tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    provenance: input.provenance ?? {},
    createdAt: now.toISOString(),
    answeredAt: null,
    expiredAt: null,
  };
  // Named before anything is written: a host with no door refuses here, and
  // leaves no ask behind that nobody could answer.
  const url = records.answerUrl(stored.token);
  await records.kv.set(askKey(stored.id), stored);
  await records.kv.set(tokenKey(stored.token), stored.id);
  return (await getAsk(records, stored.id)) ?? { ...stored, url };
}

/** The ask, as the host keeps it now; null when there is none. A record that
 *  does not read as an ask is a host fault, raised rather than skipped. */
export async function getAsk(records: AskRecords, id: string): Promise<AskRecord | null> {
  const raw = await records.kv.get(askKey(id));
  if (raw === undefined || raw === null) return null;
  const parsed = askRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`ask ${id}: the stored record does not read as an ask (${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'})`);
  }
  return withUrl(parsed.data, records.answerUrl);
}

/** The ask a capability token answers; null for a token that is not one. */
export async function askByToken(records: AskRecords, token: string): Promise<AskRecord | null> {
  if (!token.startsWith(ASK_TOKEN_PREFIX)) return null;
  const id = await records.kv.get(tokenKey(token));
  return typeof id === 'string' ? getAsk(records, id) : null;
}

// ── The lattice ─────────────────────────────────────────────────────────────

/** What an answer or a cancel came to — one vocabulary for every door. */
export type AskOutcome =
  /** No such ask. */
  | { kind: 'not_found' }
  /** Answered (or cancelled) just now — a run parked on it will resume. */
  | { kind: 'settled'; ask: AskRecord }
  /** Already settled (answered elsewhere / cancelled) or the token has lapsed —
   *  closed-request-wins: whoever raced sees the terminal state. */
  | { kind: 'closed'; ask: AskRecord }
  /** The submitted value did not fit the family's answer type. */
  | { kind: 'invalid'; message: string; ask: AskRecord };

/**
 * Settle an open ask: write `next` over it, and when the host refuses (another
 * writer settled it first), report what the record says now.
 */
async function settle(records: AskRecords, current: AskRecord, next: StoredAsk): Promise<AskOutcome> {
  try {
    await records.kv.set(askKey(current.id), next);
  } catch (error) {
    const now = await getAsk(records, current.id);
    if (now !== null && now.state !== 'open') return { kind: 'closed', ask: now };
    throw error;
  }
  return { kind: 'settled', ask: (await getAsk(records, current.id)) ?? withUrl(next, records.answerUrl) };
}

function stored(ask: AskRecord): StoredAsk {
  const { url: _url, ...rest } = ask;
  return rest;
}

/**
 * Answer an ask: coerce the raw value against the family, then `open →
 * answered`. The token-expiry window gates only the login-less link, not the
 * ask's life, so an expired token on an otherwise-open ask still refuses.
 */
export async function answerAsk(records: AskRecords, input: { id: string; raw: unknown }): Promise<AskOutcome> {
  const current = await getAsk(records, input.id);
  if (current === null) return { kind: 'not_found' };
  if (current.state !== 'open') return { kind: 'closed', ask: current };
  if (new Date(current.tokenExpiresAt).getTime() <= Date.now()) return { kind: 'closed', ask: current };
  const coerced = coerceAnswer(current, input.raw);
  if (!coerced.ok) return { kind: 'invalid', message: coerced.error, ask: current };
  return settle(records, current, {
    ...stored(current),
    state: 'answered',
    answer: coerced.value,
    answeredAt: new Date().toISOString(),
  });
}

/** Cancel an open ask: `open → expired`. A settled ask is `closed` — the
 *  caller decides whether that is an error. */
export async function cancelAsk(records: AskRecords, input: { id: string }): Promise<AskOutcome> {
  const current = await getAsk(records, input.id);
  if (current === null) return { kind: 'not_found' };
  if (current.state !== 'open') return { kind: 'closed', ask: current };
  return settle(records, current, { ...stored(current), state: 'expired', expiredAt: new Date().toISOString() });
}

/** Everything an answer can come to that is NOT an accepted answer. */
export type AskRefusal = Exclude<AskOutcome, { kind: 'settled' }>;

/**
 * The Response write, refused. Thrown by the adapter's write path, which has
 * no non-throwing failure channel, and carries the outcome so a caller
 * branches on `.outcome.kind` rather than a message.
 */
export class AskResponseRefused extends Error {
  constructor(readonly outcome: AskRefusal) {
    super(refusalMessage(outcome));
    this.name = 'AskResponseRefused';
  }
}

export function refusalMessage(outcome: AskRefusal): string {
  switch (outcome.kind) {
    case 'not_found':
      return 'that request no longer exists — nothing can be answered against it';
    case 'closed':
      return `that request is already closed (${
        outcome.ask.state === 'answered' ? 'answered' : 'cancelled or expired'
      }) — the first answer stands`;
    case 'invalid':
      return `that answer was not accepted: ${outcome.message}`;
  }
}
