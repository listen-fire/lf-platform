// The `system` module served to a cloud lf: adapter protocol 2 over Express.
// It is the module the platform loads in process (`@listen-fire/system`, over
// the platform's records of its runs and events), so lf polls the same events
// with the same marks and the same rule against an automation hearing of its
// own failures. Who may call it is the router's question (the system caller
// and its key); the tenant is the key owner's team, never a setting and never
// the request's team header, which lf fills with its own team.
//
// The kit's HTTP handler reads the body from the socket, which the app's JSON
// parser has already read, so this answers the parsed body with the kit's
// pieces: the envelope checked as the kit checks it, `poll` from the loaded
// module, every other method (`manifest` first among them) as the kit answers
// an adapter.
//
// One field is added on the way out: each polled event's `eventType`, the
// kind's natural name. lf (0.12.6) narrows every event a listen receives to
// the listen's `events` by `eventType`, polled ones included, and drops an
// event without one; the platform's own poll dispatch does not narrow, so the
// module leaves it unset (the protocol's rule for a poll). The name is the
// one the listen selected with, so the narrowing passes what the poll chose.

import type { Request, RequestHandler } from 'express';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { METHODS, PROTOCOL_VERSION, RpcRequest, type MethodName } from 'engine-contracts';
import { adapterInProcess, noCredential, refusingFiles, refusingKv, type InProcessAdapterModule, type PollAnswer } from 'module-kit';
import { answerAdapterRequest, errorAnswer, errorEnvelope, type CheckedRequest, type ProtocolAnswer } from 'module-kit/server';
import { SYSTEM_EVENT_KINDS, systemModuleWith } from '@listen-fire/system';

import { logger } from 'movement-engine/public/log';
import { platformSystemRecords } from '../../../services/translation_graph/adapters/system/events';

const SYSTEM_MODULE = systemModuleWith(platformSystemRecords);

function isMethodName(method: string): method is MethodName {
  return Object.hasOwn(METHODS, method);
}

/** The request as the kit's server checks it before anything is
 *  interpreted: not an envelope is HTTP 400; another protocol version, an
 *  unknown method or params that do not fit the method answer in the
 *  envelope, not retryable. */
function checkedRequest(body: unknown): { ok: true; request: CheckedRequest } | { ok: false; answer: ProtocolAnswer } {
  const parsed = RpcRequest.safeParse(body);
  if (!parsed.success) {
    return { ok: false, answer: { status: 400, body: errorEnvelope('bad_request', 'Malformed request: not a protocol 2 envelope', false) } };
  }
  const { method, params } = parsed.data;
  if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, answer: { status: 200, body: errorEnvelope('protocol_version', `expected protocol version ${PROTOCOL_VERSION}`, false) } };
  }
  if (!isMethodName(method)) {
    return { ok: false, answer: { status: 200, body: errorEnvelope('method_not_implemented', `Unknown method "${method}".`, false) } };
  }
  if (!METHODS[method].params.safeParse(params).success) {
    return { ok: false, answer: { status: 200, body: errorEnvelope('bad_request', `${method}: params do not match the method's schema`, false) } };
  }
  return { ok: true, request: { method, params } };
}

/** The module loaded for one tenant. It declares no credential and keeps no
 *  state or files: what it reads is the platform's records. */
function loadFor(teamId: TeamId): InProcessAdapterModule {
  const unavailable = `module ${SYSTEM_MODULE.name} keeps nothing of its own`;
  return adapterInProcess(SYSTEM_MODULE, {
    tenant: teamId,
    credential: noCredential(`module ${SYSTEM_MODULE.name} declares no credential`),
    kv: refusingKv(unavailable),
    files: refusingFiles(unavailable),
    log: logger,
    validateResults: false,
  });
}

/** Each event with its kind's natural name as its `eventType`. */
function withEventTypes(answer: PollAnswer): PollAnswer {
  return {
    ...answer,
    events: answer.events.map((event) => {
      const kind = SYSTEM_EVENT_KINDS.find((k) => k.tag === event.tag);
      return kind === undefined ? event : { ...event, eventType: kind.displayName };
    }),
  };
}

async function answer(teamId: TeamId, request: CheckedRequest): Promise<ProtocolAnswer> {
  const loaded = loadFor(teamId);
  if (request.method === 'poll') {
    const { poll } = loaded;
    if (poll === undefined) {
      return { status: 200, body: errorEnvelope('method_not_implemented', `Module ${SYSTEM_MODULE.name} does not implement "poll".`, false) };
    }
    try {
      return { status: 200, body: { ok: true, result: withEventTypes(await poll(METHODS.poll.params.parse(request.params))) } };
    } catch (error) {
      return { status: 200, body: errorAnswer('poll', error) };
    }
  }
  return answerAdapterRequest(
    { adapter: loaded.adapter, manifest: () => loaded.manifest, warn: (message) => logger.warn(message) },
    request,
  );
}

/** Serve the system module in the tenant `tenantOf` reads off the request. */
export function systemAdapterHandler(tenantOf: (req: Request) => TeamId): RequestHandler {
  return async (req, res) => {
    const checked = checkedRequest(req.body);
    const answered = checked.ok ? await answer(tenantOf(req), checked.request) : checked.answer;
    if (!answered.body.ok) {
      // Never the params: a checkpoint is the module's own text.
      logger.warn(`[system-adapter] ${checked.ok ? checked.request.method : 'request'} refused`, { code: answered.body.error.code });
    }
    res.status(answered.status).json(answered.body);
  };
}
