import { randomUUID } from "node:crypto";

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { currentPrincipal } from 'principal';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { catchingRoutes } from '../async_route';
import { listTgRuns, getTgRun } from '../../../services/system_debug';
import { drainUntilIdle, recordExternalDrainPass } from '../../../services/work/drain';
import { mounts } from '../../../products';
import { rustRunStats } from 'movement-engine/public/movement-engine';
import { LF_STORE_MANIFEST, answerFor as storeAnswerFor } from '../../../services/lf_store/answer';
import { LF_MOVEMENTS_MANIFEST, answerFor as movementsAnswerFor } from '../../../services/lf_movements/answer';
import { slotHandler } from './slots';
import { systemAdapterHandler } from './system_adapter';
import {
  requireSystemAction,
  requireSystemCaller,
  requireTenantCaller,
} from '../../../services/system_auth';

function internalError(res: Parameters<RequestHandler>[1], err: unknown) {
  const traceId = randomUUID();
  console.error(`[system-api:${traceId}]`, err);
  return res.status(500).json({
    error: 'internal_error',
    message: 'An internal error occurred.',
    traceId,
  });
}

/** The floor under every route in this router — see `async_route.ts` for why an
 *  unwrapped async handler HANGS rather than 500s. */
const route = catchingRoutes(internalError);

/**
 * The tenant these routes act in, read off the Principal rather than through
 * `Context.user`. `user` is user-SHAPED and throws when there is no user, and
 * an api key minted for a service — or the static single-tenant stub a coreless
 * deployment boots with — is a machine principal with none (D2). Every read
 * below wanted a team id, not a person.
 */
function actingTeamId(): TeamId {
  return currentPrincipal().teamId as TeamId;
}

const paginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Messages ──

const listTgRunsQuerySchema = paginationSchema.extend({
  triggerId: z.string().optional(),
  status: z.string().optional(),
});

const listTgRunsHandler: RequestHandler = async (req, res) => {
  const parsed = listTgRunsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  }
  try {
    const data = await listTgRuns({
      teamId: actingTeamId(),
      triggerId: parsed.data.triggerId,
      status: parsed.data.status,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return res.status(200).json({ data });
  } catch (err) {
    return internalError(res, err);
  }
};

const getTgRunHandler: RequestHandler = async (req, res) => {
  try {
    const data = await getTgRun({
      teamId: actingTeamId(),
      runId: req.params.id as TriggerRunId,
    });
    if (!data) return res.status(404).json({ error: 'Trigger run not found' });
    return res.status(200).json(data);
  } catch (err) {
    return internalError(res, err);
  }
};

const drainBodySchema = z
  .object({
    // Bounded so one call cannot hold a request open for an unbounded drain.
    limit: z.number().int().positive().max(100).optional(),
    maxPasses: z.number().int().positive().max(50).optional(),
  })
  .strict();

/** The tick a scheduler calls when `AUTOMATIONS_DRAIN_MODE=external`. Each call
 *  drains until idle (bounded by `maxPasses`), records the drain worker's pulse
 *  as a loop pass would, and reports what it did. Any instance answers it, and
 *  ticks may overlap: each claims a disjoint set of rows, and each run is
 *  stepped under its own lease. */
const drainAutomationsHandler: RequestHandler = async (req, res) => {
  const body = drainBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    return res.status(400).json({ error: 'invalid_body', issues: body.error.issues });
  }
  const result = await drainUntilIdle({ owner: `http:${randomUUID()}`, ...body.data });
  recordExternalDrainPass(result);
  return res.status(200).json(result);
};

/** What the Rust engine did in THIS process since it started: the segments
 *  it ran, those it would not run (by reason: each a checker or engine bug),
 *  those that ended at their check, its shim's faults, and what it asked its
 *  host. The counters are per process and start at zero with it, so each
 *  instance answers for itself, over its uptime. */
const engineStatsHandler: RequestHandler = (_req, res) => {
  const uptimeSeconds = Math.round(process.uptime());
  return res.status(200).json({
    uptimeSeconds,
    since: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    runs: rustRunStats,
  });
};

/** lf's store slot over the platform's run tables (services/lf_store), in the
 *  tenant of the key's owner: never a setting, never a param. */
const storeSlotHandler = slotHandler(LF_STORE_MANIFEST, () => storeAnswerFor({ tenant: actingTeamId() }));

/** lf's movements slot over the team's shipped movements, read-only
 *  (services/lf_movements), in the tenant of the key's owner. */
const movementsSlotHandler = slotHandler(LF_MOVEMENTS_MANIFEST, () => movementsAnswerFor({ tenant: actingTeamId() }));

/** The `system` adapter served to lf (./system_adapter.ts): the team's
 *  failed runs, lf's among them, and the platform's stored events, in the
 *  tenant of the key's owner. */
const systemAdapterRouteHandler = systemAdapterHandler(() => actingTeamId());

const systemRouter: ReturnType<typeof Router> = Router();

// Who may call these routes is the system caller verifiers' question
// (services/system_auth): the `system` API key by default.
systemRouter.use(requireSystemCaller());

// The run listings act in the tenant of the key's owner.
const tenant = requireTenantCaller();

systemRouter.get('/tg-runs', tenant, route(listTgRunsHandler));
systemRouter.get('/tg-runs/:id', tenant, route(getTgRunHandler));
systemRouter.get('/engine-stats', route(engineStatsHandler));
// `system` is mounted on every installation, so the route gates itself the way
// index.ts gates the automations routers: absent, not refused, without the unit.
if (mounts('automations')) {
  systemRouter.post('/automations/drain', requireSystemAction('drain'), route(drainAutomationsHandler));
  systemRouter.post('/slots/store', tenant, requireSystemAction('store_slot'), route(storeSlotHandler));
  systemRouter.post('/slots/movements', tenant, requireSystemAction('movements_slot'), route(movementsSlotHandler));
  systemRouter.post('/adapters/system', tenant, requireSystemAction('system_adapter'), route(systemAdapterRouteHandler));
}

export { systemRouter };
