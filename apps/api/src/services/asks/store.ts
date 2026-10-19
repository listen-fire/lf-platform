// The platform's record of asks: the `asks.ask` table, which is the `@lf/ask`
// module's kv on the platform. What an ask IS (its families, the answer each
// accepts, its lattice) is the module's; this file only keeps the rows.
//
//   - The module reads and writes through `askTableKv`: `ask:<id>` is a row,
//     `token:<token>` names the row a link answers. A settle is written under a
//     `state = 'open'` guard, and a write the guard turns away is refused, so
//     whichever door raced loses and reads the winner (closed-request-wins).
//   - A settle is the moment the platform tells whoever waits on the ask
//     (`notifier.ts`): the engine's wake for a run parked on it, or the
//     creator's signed webhook. Every door — a Response write in movement code,
//     the link page, Slack, Telegram, MCP, the control tower, the REST cancel —
//     settles through the module and so through here, once.
//   - The platform's own surfaces (the link page, the control tower, the REST
//     API) read rows directly, as `AskRecord`s.
//
// Rows written before ask was a module are the same rows, so an ask raised
// then is answered, cancelled and awaited exactly as one raised now.

import { sql } from 'kysely';
import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { AskId } from '../../generated/kysely/asks/Ask';
import type { ModuleKv } from 'module-kit';

import {
  ASK_ANSWER_TYPES,
  ASK_FAMILIES,
  ASK_TOKEN_PREFIX,
  askRecordSchema,
  isAskAnswerType,
  isAskFamily,
  type AskAnswerType,
  type AskFamily,
  type AskProvenance,
  type AskRecord as ModuleAskRecord,
  type AskRecords,
  type AskRowSpec,
  type AskState,
  type StoredAsk,
} from '@listen-fire/ask';
import { getAsksQb } from '../../lib/kysely';
import { apiBaseUrl } from '../../lib/api_base_url';
import { notifyAskCancelled, notifyAskSettled } from './notifier';

export {
  ASK_ANSWER_TYPES,
  ASK_FAMILIES,
  ASK_TOKEN_PREFIX,
  isAskAnswerType,
  isAskFamily,
  type AskAnswerType,
  type AskFamily,
  type AskProvenance,
  type AskRowSpec,
  type AskState,
};

/** An ask id arriving as plain text (a correlation key, a CLI argument) — the
 *  boundary check that names it as one. */
export const askIdSchema = z.custom<AskId>(
  (value) => typeof value === 'string' && z.string().uuid().safeParse(value).success,
);

/** An ask as the platform's surfaces read it. */
export interface AskRecord {
  id: AskId;
  teamId: TeamId;
  family: AskFamily;
  answerType: AskAnswerType | null;
  prompt: string;
  detail: string | null;
  /** Choose/Select: the offered options. Form: the named fields it collects. */
  options: string[] | null;
  /** Correct only — the records offered for review. */
  rows: AskRowSpec[] | null;
  state: AskState;
  answer: unknown;
  token: string;
  /** The capability link the author delivers. */
  url: string;
  tokenExpiresAt: Date;
  provenance: AskProvenance;
  /** Where to POST when this ask settles, for a creator with no in-process
   *  notifier (the REST API's standalone callers). */
  callbackUrl: string | null;
  createdAt: Date;
  answeredAt: Date | null;
  expiredAt: Date | null;
}

/** The platform's answer door for a token: `<api>/api/asks/<token>`. */
export function askUrl(token: string): string {
  return `${apiBaseUrl()}/api/asks/${token}`;
}

interface AskRow {
  id: AskId;
  team_id: TeamId;
  family: string;
  answer_type: string | null;
  prompt: string;
  detail: string | null;
  options: unknown;
  rows: unknown;
  state: string;
  answer: unknown;
  token: string;
  token_expires_at: Date;
  provenance: unknown;
  callback_url: string | null;
  created_at: Date;
  answered_at: Date | null;
  expired_at: Date | null;
}

function rowsFromJson(raw: unknown): AskRowSpec[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AskRowSpec[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.ephemeralId !== 'string') continue;
    const fields = rec.fields !== null && typeof rec.fields === 'object' ? (rec.fields as Record<string, unknown>) : {};
    out.push({ ephemeralId: rec.ephemeralId, fields });
  }
  return out;
}

function rowToRecord(row: AskRow): AskRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    family: row.family as AskFamily,
    answerType: (row.answer_type as AskAnswerType | null) ?? null,
    prompt: row.prompt,
    detail: row.detail,
    options: Array.isArray(row.options) ? (row.options as string[]) : null,
    rows: rowsFromJson(row.rows),
    state: row.state as AskState,
    answer: row.answer ?? null,
    token: row.token,
    url: askUrl(row.token),
    tokenExpiresAt: row.token_expires_at,
    provenance: (row.provenance as AskProvenance | null) ?? {},
    callbackUrl: row.callback_url,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    expiredAt: row.expired_at,
  };
}

/** The row as the module keeps it. */
function rowToStored(row: AskRow): StoredAsk {
  const record = rowToRecord(row);
  return {
    id: record.id,
    family: record.family,
    answerType: record.answerType,
    prompt: record.prompt,
    detail: record.detail,
    options: record.options,
    rows: record.rows,
    state: record.state,
    answer: record.answer,
    token: record.token,
    tokenExpiresAt: record.tokenExpiresAt.toISOString(),
    provenance: { ...record.provenance },
    createdAt: record.createdAt.toISOString(),
    answeredAt: record.answeredAt?.toISOString() ?? null,
    expiredAt: record.expiredAt?.toISOString() ?? null,
  };
}

const SELECT_COLUMNS = [
  'id', 'team_id', 'family', 'answer_type', 'prompt', 'detail', 'options', 'rows',
  'state', 'answer', 'token', 'token_expires_at', 'provenance', 'callback_url',
  'created_at', 'answered_at', 'expired_at',
] as const;

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

// ── Reads ──────────────────────────────────────────────────────────────────

async function rowById(id: string): Promise<AskRow | undefined> {
  const parsed = askIdSchema.safeParse(id);
  if (!parsed.success) return undefined;
  const row = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('id', '=', parsed.data)
    .select([...SELECT_COLUMNS])
    .executeTakeFirst();
  return row as AskRow | undefined;
}

export async function getAsk(id: AskId): Promise<AskRecord | null> {
  const row = await rowById(id);
  return row ? rowToRecord(row) : null;
}

/** Look an ask up by its capability token — the link surface's entry point.
 *  Returns null for a token that is not an ask's (so the route falls back to
 *  the legacy store). */
export async function lookupAskByToken(token: string): Promise<AskRecord | null> {
  if (!token.startsWith(ASK_TOKEN_PREFIX)) return null;
  const row = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('token', '=', token)
    .select([...SELECT_COLUMNS])
    .executeTakeFirst();
  return row ? rowToRecord(row as AskRow) : null;
}

/** Every ask for a team, newest first — the "your asks" home and the dev
 *  loop's inspection. Not exposed inside movements: asks are one-shots. */
export async function listAsksForTeam(teamId: TeamId, limit = 100): Promise<AskRecord[]> {
  const rows = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('team_id', '=', teamId)
    .select([...SELECT_COLUMNS])
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => rowToRecord(r as AskRow));
}

// ── The module's kv ────────────────────────────────────────────────────────

/** A settle another door won: the module re-reads and reports it closed. */
class AskAlreadySettled extends Error {
  constructor(id: string) {
    super(`ask ${id} has already settled`);
    this.name = 'AskAlreadySettled';
  }
}

async function insertAsk(teamId: TeamId, ask: StoredAsk, callbackUrl: string | null): Promise<void> {
  await getAsksQb(['ask'])
    .insertInto('ask')
    .values({
      id: ask.id as AskId,
      team_id: teamId,
      family: ask.family,
      answer_type: ask.answerType,
      prompt: ask.prompt,
      detail: ask.detail,
      options: ask.options !== null ? (jsonb(ask.options) as never) : null,
      rows: ask.rows !== null ? (jsonb(ask.rows) as never) : null,
      token: ask.token,
      token_expires_at: new Date(ask.tokenExpiresAt),
      provenance: jsonb(ask.provenance) as never,
      callback_url: callbackUrl,
    })
    .execute();
}

/** Write a settle over an open row and tell whoever waits; refused when the
 *  row has settled already. Only the settle is written: everything else on an
 *  ask is immutable once raised. */
async function settleAsk(teamId: TeamId, ask: StoredAsk): Promise<void> {
  if (ask.state === 'open') return;
  const now = new Date();
  const row = await getAsksQb(['ask'])
    .updateTable('ask')
    .set(
      ask.state === 'answered'
        ? { state: 'answered', answer: jsonb(ask.answer) as never, answered_at: new Date(ask.answeredAt ?? now), updated_at: now }
        : { state: 'expired', expired_at: new Date(ask.expiredAt ?? now), updated_at: now },
    )
    .where('id', '=', ask.id as AskId)
    .where('team_id', '=', teamId)
    .where('state', '=', 'open')
    .returning([...SELECT_COLUMNS])
    .executeTakeFirst();
  if (!row) throw new AskAlreadySettled(ask.id);
  const settled = rowToRecord(row as AskRow);
  // Awaited so a queued wake is durable before the door says it took the
  // answer; neither throws, so a notification fault never fails a settle.
  if (settled.state === 'answered') await notifyAskSettled(settled);
  else await notifyAskCancelled(settled);
}

/**
 * The `@lf/ask` module's kv for one team, over the asks table. `callbackUrl`
 * is recorded on an ask raised through this kv — the REST API's creator who
 * asked to be told when it settles.
 */
export function askTableKv(teamId: TeamId, options: { callbackUrl?: string | null } = {}): ModuleKv {
  const refuse = (what: string): never => {
    throw new Error(`ask: the platform keeps asks in its asks table, which takes no ${what}`);
  };
  return {
    async get(key) {
      if (key.startsWith('ask:')) {
        const row = await rowById(key.slice('ask:'.length));
        return row !== undefined && row.team_id === teamId ? rowToStored(row) : undefined;
      }
      if (key.startsWith('token:')) {
        const row = await getAsksQb(['ask'])
          .selectFrom('ask')
          .where('token', '=', key.slice('token:'.length))
          .where('team_id', '=', teamId)
          .select('id')
          .executeTakeFirst();
        return row?.id;
      }
      return undefined;
    },
    async set(key, value) {
      if (key.startsWith('token:')) {
        // The token is a column of the row the ask's own key wrote.
        const row = await rowById(String(value));
        if (row === undefined || row.team_id !== teamId || row.token !== key.slice('token:'.length)) {
          refuse('token that names no ask of this team');
        }
        return;
      }
      if (!key.startsWith('ask:')) return refuse(`key "${key}"`);
      const ask = askRecordSchema.parse(value);
      if (ask.id !== key.slice('ask:'.length)) return refuse('ask under another ask\'s key');
      const existing = await rowById(ask.id);
      if (existing === undefined) return insertAsk(teamId, ask, options.callbackUrl ?? null);
      if (existing.team_id !== teamId) return refuse('ask of another team');
      return settleAsk(teamId, ask);
    },
    async delete() {
      refuse('delete: asks are receipts and are cancelled, never removed');
    },
    async list(prefix) {
      if (!prefix.startsWith('ask:')) return [];
      const rows = await getAsksQb(['ask'])
        .selectFrom('ask')
        .where('team_id', '=', teamId)
        .select([...SELECT_COLUMNS])
        .orderBy('created_at', 'asc')
        .execute();
      return rows
        .map((row) => ({ key: `ask:${row.id}`, value: rowToStored(row as AskRow) }))
        .filter((entry) => entry.key.startsWith(prefix));
    },
  };
}

/** The module's records for one team, on the platform. */
export function platformAskRecords(teamId: TeamId, options: { callbackUrl?: string | null } = {}): AskRecords {
  return { kv: askTableKv(teamId, options), answerUrl: askUrl };
}

/** A module record as the platform's surfaces read it, for the team that
 *  holds it and the creator's callback the module never sees. */
export function platformView(ask: ModuleAskRecord, holder: { teamId: TeamId; callbackUrl: string | null }): AskRecord {
  return {
    id: ask.id as AskId,
    teamId: holder.teamId,
    family: ask.family,
    answerType: ask.answerType,
    prompt: ask.prompt,
    detail: ask.detail,
    options: ask.options,
    rows: ask.rows,
    state: ask.state,
    answer: ask.answer ?? null,
    token: ask.token,
    url: ask.url,
    tokenExpiresAt: new Date(ask.tokenExpiresAt),
    provenance: ask.provenance,
    callbackUrl: holder.callbackUrl,
    createdAt: new Date(ask.createdAt),
    answeredAt: ask.answeredAt !== null ? new Date(ask.answeredAt) : null,
    expiredAt: ask.expiredAt !== null ? new Date(ask.expiredAt) : null,
  };
}
