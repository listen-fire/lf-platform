// The movements slot served over a team's saved movements, read-only. The
// tenant is the key owner's team, as for the store slot, and the team must be
// lf-engined (LF_ENGINE_TEAMS): otherwise the platform runs its listeners, and
// serving them to lf too would run each twice. What is listed is rows.ts's
// rule. A write is answered `read_only` after its params are checked: the
// platform's authoring is the only writer, since a save there checks the text,
// can stop for consent, and provisions listeners, none of which the wire's
// write can carry.
//
// Nothing secret or textual leaves in a log or an error: a failure is a fixed
// text naming the method and path, never the movement's text.

import { z } from 'zod';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module_wire/wire';
import { MANIFEST_PROTOCOL_VERSION } from 'engine-contracts';
import {
  MOVEMENTS_METHODS,
  MovementsReadRequest,
  MovementsWriteRequest,
  type MovementsWriteAnswerShape,
  type WireSlotManifestShape,
} from 'engine-contracts/slots';

import { isLfEngineTeam } from '../lf_engine/teams';
import { servedMovement, servedMovements, type ServedMovementsTenant } from './rows';

export const LF_MOVEMENTS_MANIFEST: WireSlotManifestShape = {
  protocolVersion: MANIFEST_PROTOCOL_VERSION,
  name: 'lf-platform-movements',
  kind: 'core',
  slot: 'movements',
  methods: [...MOVEMENTS_METHODS],
};

export const READ_ONLY_REASON =
  "the platform's authoring is the only writer of this team's movements: save them in the platform, which checks them and provisions their listeners";

interface AnswerDeps {
  isLfEngineTeam(teamId: string): boolean;
}

function parsed<S extends z.ZodType>(method: string, schema: S, params: Record<string, unknown>): z.output<S> {
  const result = schema.safeParse(params);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new SlotRefusal('bad_request', `${method}: ${issue?.path.join('.') || 'params'}: ${issue?.message ?? 'not this method\'s params'}`);
  }
  return result.data;
}

/** The method and path a failure names: never a text. */
function failureText(method: string, params: Record<string, unknown>): string {
  const verb = method.startsWith('movements.') ? method.slice('movements.'.length) : method;
  const path = typeof params.path === 'string' ? params.path : 'the movements';
  return `the platform could not ${verb} "${path}"`;
}

async function dispatch(scope: ServedMovementsTenant, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'movements.list':
      return servedMovements(scope);
    case 'movements.read':
      return servedMovement(scope, parsed(method, MovementsReadRequest, params).path);
    case 'movements.write': {
      parsed(method, MovementsWriteRequest, params);
      const answer: MovementsWriteAnswerShape = { kind: 'read_only', reason: READ_ONLY_REASON };
      return answer;
    }
    default:
      throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
  }
}

/** The slot's answer in one tenant. `manifest` never reaches it (the route
 *  answers it), so a team that is not lf-engined is refused everything here. */
export function answerFor(scope: ServedMovementsTenant, deps: AnswerDeps = { isLfEngineTeam }): SlotAnswer {
  return async (method, params, settings) => {
    if (!deps.isLfEngineTeam(scope.tenant)) {
      throw new SlotRefusal(
        'settings',
        `team \`${scope.tenant}\` runs its automations on the platform: add it to LF_ENGINE_TEAMS before lf runs them`,
      );
    }
    if (settings.tenant !== undefined && settings.tenant !== scope.tenant) {
      throw new SlotRefusal('settings', 'the `tenant` setting names another team: this module serves the team that owns the key');
    }
    try {
      return await dispatch(scope, method, params);
    } catch (error) {
      if (error instanceof SlotRefusal) throw error;
      throw new Error(failureText(method, params));
    }
  };
}
