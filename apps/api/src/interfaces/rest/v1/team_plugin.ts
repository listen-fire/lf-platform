// `@lf-platform/team` served to a cloud lf: adapter protocol 2 over Express,
// for a plugin module (`manifest` and `invokePlugin`). It is the module the
// platform loads in process (`teamModuleWith`, over the platform's membership
// records), so a cloud lf's `team.isMember(address)` is answered by the same
// rule as a platform run's. Who may call it is the router's question (the
// system caller and its key); the tenant is the key owner's team, never the
// request's team header, which lf fills with its own team.
//
// The platform cannot tell a cloud lf that an answer changed (the lf serves no
// door to push to), so every answer carries the plugin's `maxAgeSeconds` and
// the lf's own cache is the only one that can go stale.


import { METHODS } from 'engine-contracts';
import { errorAnswer, errorEnvelope, type CheckedRequest, type ProtocolAnswer } from 'module-kit/server';
import { logger } from 'movement-engine/public/log';
import { pluginProgramName } from 'movement-engine/public/plugins';
import { pluginKey } from 'movement-lang';
import { IS_MEMBER, TEAM_PLUGINS_PACKAGE } from '@lf-platform/team/plugins';

import type { InProcessPluginModule } from 'module-kit';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { RequestHandler, Request } from 'express';

import { builtinPluginModule } from '../../../services/translation_graph/adapters/builtin_modules';
import { checkedRequest } from './system_adapter';

const TEAM_PLUGIN_KEY = pluginKey(TEAM_PLUGINS_PACKAGE, pluginProgramName(IS_MEMBER.signature.name));

/** The plugin module for one tenant: the platform's registered line, loaded
 *  (with `pluginsInProcess`) as a run's call loads it. */
function loadFor(teamId: TeamId): InProcessPluginModule {
  const loaded = builtinPluginModule(TEAM_PLUGIN_KEY, { teamId });
  if (loaded === undefined) throw new Error(`the platform has no module line for ${TEAM_PLUGIN_KEY}`);
  return loaded;
}

async function answer(teamId: TeamId, request: CheckedRequest): Promise<ProtocolAnswer> {
  const loaded = loadFor(teamId);
  switch (request.method) {
    case 'manifest':
      return { status: 200, body: { ok: true, result: loaded.manifest } };
    case 'invokePlugin':
      try {
        return { status: 200, body: { ok: true, result: await loaded.invoke(METHODS.invokePlugin.params.parse(request.params)) } };
      } catch (error) {
        return { status: 200, body: errorAnswer('invokePlugin', error) };
      }
    default:
      return { status: 200, body: errorEnvelope('method_not_implemented', `Module @lf-platform/team does not implement "${request.method}".`, false) };
  }
}

/** Serve the team module in the tenant `tenantOf` reads off the request. */
export function teamPluginHandler(tenantOf: (req: Request) => TeamId): RequestHandler {
  return async (req, res) => {
    const checked = checkedRequest(req.body);
    const answered = checked.ok ? await answer(tenantOf(req), checked.request) : checked.answer;
    if (!answered.body.ok) {
      // Never the params: a claim is a person's address.
      logger.warn(`[team-plugin] ${checked.ok ? checked.request.method : 'request'} refused`, { code: answered.body.error.code });
    }
    res.status(answered.status).json(answered.body);
  };
}
