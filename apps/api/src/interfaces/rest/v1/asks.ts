// The asks unit's own REST surface (`/api/v1/asks`, coarse scope `asks`).
//
// Thin wrappers over the store and the answer door, because the door
// invariants ARE the product: create always creates (F16 — no dedupe surface),
// the lattice is `open → answered | expired` and both are terminal, and a
// second answer loses to the first. Nothing here re-implements any of that; it
// resolves a team, checks ownership, and calls the same functions the adapter
// and the link page call.
//
// The human answer surface is NOT here. `GET/POST /api/asks/:token` already is
// the third-party-agnostic way a person answers, needs no key, and is
// unchanged — this router is for the SYSTEM that raised the question, not the
// human answering it.
//
// Team scoping is explicit and caller-side on purpose (§4): `getAsk` and
// `cancelAskAndWake` do not check ownership themselves, so every route that reaches
// an ask by id compares `ask.teamId` before doing anything with it, and a
// mismatch is a 404 rather than a 403 — another team's ask should not be
// discoverable by probing ids. A question a run asked is its automation's
// besides (`access_route.ts`): the list keeps only those the caller may read,
// one the caller may not read is a 404 too, and a cancel, which wakes the run
// parked on it, needs write.
//
// offset paging

import { randomUUID } from 'node:crypto';

import { Router, type Response } from 'express';
import { z } from 'zod';
import { currentPrincipal } from 'principal';
import { neverAsAny } from 'movement-engine/public/types';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { AskId } from '../../../generated/kysely/asks/Ask';

import {
  ASK_ANSWER_TYPES,
  ASK_FAMILIES,
  getAsk,
  listAsksForTeam,
  type AskRecord,
} from '../../../services/asks/store';
import { cancelAskAndWake, createAsk } from '../../../services/asks/doors';
import { readAskDeliveryHealth } from '../../../services/asks/webhook_delivery/worker';
import { askSettleDelivery } from '../../../services/asks/delivery_mode';
import { requireScope } from './require_scope';
import { READ_ONLY_MESSAGE, decidingRouter, readableOwned, refusalOn } from '../../access_route';
import { Whose } from '../../../services/access/whose';

const ASKS_SCOPE = 'asks';

/**
 * The tenant this call acts in — asks' only identity touchpoint (§3), read off
 * the Principal rather than through `Context.user`. `user` is user-SHAPED and
 * throws when there is no user, and an api key or the static single-tenant stub
 * is a machine principal with none (D2): reading it there made every route in
 * this router a 500 in exactly the standalone deployment asks exists to prove.
 */
function teamId(): TeamId {
  return currentPrincipal().teamId as TeamId;
}

function internalError(res: Response, err: unknown) {
  const traceId = randomUUID();
  console.error(`[asks-api:${traceId}]`, err);
  return res.status(500).json({ error: 'internal_error', message: 'An internal error occurred.', traceId });
}

/** The wire shape. `provenance` and `callbackUrl` go out exactly as they came
 *  in — the store parses neither (A-3). */
function view(ask: AskRecord) {
  return {
    id: ask.id,
    teamId: ask.teamId,
    family: ask.family,
    answerType: ask.answerType,
    prompt: ask.prompt,
    detail: ask.detail,
    options: ask.options,
    rows: ask.rows,
    state: ask.state,
    answer: ask.answer,
    url: ask.url,
    tokenExpiresAt: ask.tokenExpiresAt.toISOString(),
    provenance: ask.provenance,
    callbackUrl: ask.callbackUrl,
    createdAt: ask.createdAt.toISOString(),
    answeredAt: ask.answeredAt?.toISOString() ?? null,
    expiredAt: ask.expiredAt?.toISOString() ?? null,
  };
}

const rowSpecSchema = z.object({
  ephemeralId: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
});

const createSchema = z.object({
  family: z.enum(ASK_FAMILIES),
  prompt: z.string().min(1),
  detail: z.string().nullish(),
  answerType: z.enum(ASK_ANSWER_TYPES).nullish(),
  /** Choose/Select: the offered options. Form: the named fields it collects. */
  options: z.array(z.string()).nullish(),
  /** Correct only: the records offered for review. */
  rows: z.array(rowSpecSchema).nullish(),
  callbackUrl: z.string().url().nullish(),
  /** Opaque to the store, echoed back verbatim on every read and on the
   *  settle webhook. */
  provenance: z.record(z.string(), z.unknown()).optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const uuidParam = z.object({ id: z.string().uuid() });

/** The asks the caller may read, newest first: `want` of them, or every one the team has. */
async function readableAsksForTeam(team: TeamId, want: number): Promise<AskRecord[]> {
  for (let window = want; ; window *= 2) {
    const asks = await listAsksForTeam(team, window);
    const owners = await Whose.automationsOfAsks({ askIds: asks.map((ask) => ask.id), teamIds: [team] });
    const readable = await readableOwned(asks, { owners, keyOf: (ask) => ask.id, teamIds: [team] });
    if (readable.length >= want || asks.length < window) return readable.slice(0, want);
  }
}

const asksRouter: ReturnType<typeof Router> = Router();
const route = decidingRouter(asksRouter, '/v1/asks');

asksRouter.use(requireScope(ASKS_SCOPE));

// GET /api/v1/asks/health — is the settle notification path alive, and is
// anything stuck in it. Publishes the delivery MODE so a split deployment whose
// two halves disagree can be seen to, rather than falling silent.
route.get('/health', { exempt: 'the settle notification path, no question' }, async (_req, res) => {
  try {
    return res.status(200).json({ data: { delivery: askSettleDelivery(), ...(await readAskDeliveryHealth()) } });
  } catch (err) {
    return internalError(res, err);
  }
});

// POST /api/v1/asks — raise a question. Always creates (F16).
route.post('/', { exempt: 'raises a question of no automation, which only team membership decides' }, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.format() });
  }
  const body = parsed.data;
  try {
    const ask = await createAsk({
      teamId: teamId(),
      family: body.family,
      prompt: body.prompt,
      ...(body.detail !== undefined ? { detail: body.detail ?? null } : {}),
      ...(body.answerType !== undefined ? { answerType: body.answerType ?? null } : {}),
      ...(body.options !== undefined ? { options: body.options ?? null } : {}),
      ...(body.rows !== undefined ? { rows: body.rows ?? null } : {}),
      ...(body.callbackUrl !== undefined ? { callbackUrl: body.callbackUrl ?? null } : {}),
      ...(body.provenance !== undefined ? { provenance: body.provenance } : {}),
    });
    return res.status(201).json({ data: view(ask) });
  } catch (err) {
    return internalError(res, err);
  }
});

// GET /api/v1/asks — this team's asks the caller may read, newest first, offset-paged.
route.get('/', { thing: 'automation', verb: 'read' }, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query', issues: parsed.error.format() });
  }
  const { limit, offset } = parsed.data;
  try {
    // The store's list is the whole team's, newest first; paging slices it here
    // rather than growing the store a paging surface it has one caller for.
    const all = await readableAsksForTeam(teamId(), offset + limit);
    const page = all.slice(offset);
    return res.status(200).json({
      data: page.map(view),
      pagination: { limit, offset, count: page.length },
    });
  } catch (err) {
    return internalError(res, err);
  }
});

// GET /api/v1/asks/:id — one ask. Another team's, or one whose automation the
// caller may not read, is a 404, not a 403.
route.get('/:id', { thing: 'automation', verb: 'read' }, async (req, res) => {
  const parsed = uuidParam.safeParse(req.params);
  if (!parsed.success) return res.status(404).json({ error: 'not_found' });
  try {
    const owner = await Whose.automationOfAsk({ askId: parsed.data.id, teamIds: [teamId()] });
    if (owner === undefined || (await refusalOn({ automationId: owner.automationId, verb: 'read' })) !== undefined) {
      return res.status(404).json({ error: 'not_found' });
    }
    const ask = await getAsk(parsed.data.id as AskId);
    if (!ask || ask.teamId !== teamId()) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json({ data: view(ask) });
  } catch (err) {
    return internalError(res, err);
  }
});

// POST /api/v1/asks/:id/cancel — withdraw an unanswered question. Refuses
// OBSERVABLY on an already-settled one: the first outcome stands, and the
// caller is told which one it was rather than being handed a silent no-op.
route.post('/:id/cancel', { thing: 'automation', verb: 'write' }, async (req, res) => {
  const parsed = uuidParam.safeParse(req.params);
  if (!parsed.success) return res.status(404).json({ error: 'not_found' });
  try {
    const owner = await Whose.automationOfAsk({ askId: parsed.data.id, teamIds: [teamId()] });
    if (owner === undefined) return res.status(404).json({ error: 'not_found' });
    const refusal = await refusalOn({ automationId: owner.automationId, verb: 'write' });
    switch (refusal) {
      case undefined:
        break;
      case 'unseen':
        return res.status(404).json({ error: 'not_found' });
      case 'read_only':
        return res.status(403).json({ error: 'forbidden', message: READ_ONLY_MESSAGE });
      default:
        return neverAsAny(refusal);
    }
    const existing = await getAsk(parsed.data.id as AskId);
    if (!existing || existing.teamId !== teamId()) return res.status(404).json({ error: 'not_found' });
    const outcome = await cancelAskAndWake({ id: existing.id });
    if (outcome.ok) return res.status(200).json({ data: view(outcome.ask) });
    if (outcome.reason === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(409).json({
      error: 'already_settled',
      message: 'that request is already closed — the first outcome stands',
      ...(outcome.ask ? { data: view(outcome.ask) } : {}),
    });
  } catch (err) {
    return internalError(res, err);
  }
});

export { asksRouter, ASKS_SCOPE };
