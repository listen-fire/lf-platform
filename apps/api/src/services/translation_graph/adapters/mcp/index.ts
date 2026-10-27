// What the platform adds to `@lf/mcp` as its host. Each connection is one MCP
// server the team names by URL, so every request the module makes goes to an
// address a user supplied: it goes through the platform's public-address fetch
// (https, public addresses only, checked again when the connection opens).
// Each request counts against the run's ceiling on calls to remote systems and
// asks the platform's limiter first, as a remote module's calls do, so a
// server's 429 holds the connection's next requests on every instance.
//
// The platform stores one of the module's two credentials: the token
// (`mcp_token`: the server URL, the token, and optionally the header it goes
// in). The OAuth one (`mcp`) needs an OAuth app per server, whose endpoints
// vary per server; the platform has no place for a team's own OAuth app on a
// bundled module yet, so it is not offered.

import { z } from 'zod';

import { countAdapterCall } from 'module-runtime/run_scope';
import type { ModuleDefinition } from 'module-kit';
import { MCP_ADAPTER_TYPE, MCP_MANIFEST } from '@listen-fire/mcp/manifest';
import { TOKEN_CREDENTIAL } from '@listen-fire/mcp/client';
import type { AdapterManifest } from 'movement-engine/public/adapter';
import { limitRequest, limited, limiterSlot, throttleAfter, vendorWaitMs, type Caller } from 'movement-engine/public/limiter';

import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { publicFetch, urlRefusal } from '../../../../lib/net/public_fetch';
import type { BuiltinInstall } from '../builtin_modules';

/** The module's own manifest, with the credential type the platform stores
 *  an MCP connection under. */
export const MCP_PLATFORM_MANIFEST: AdapterManifest = { ...MCP_MANIFEST, requiredCredentialType: ExternalServiceType.MCP };

/** The declared credential a stored MCP connection fills. */
export const MCP_STORED_CREDENTIAL = TOKEN_CREDENTIAL;

const LABEL = 'MCP server';

/** A stored MCP connection: the token credential's fields, as the module
 *  declares them. */
export const mcpCredsShape = z.object({
  url: z.string(),
  token: z.string().min(1),
  header: z.string().optional(),
});

/** The same, its URL held to the rule its requests are. */
export const mcpCredsParser = mcpCredsShape.superRefine((credentials, ctx) => {
  const refusal = mcpUrlRefusal(credentials.url);
  if (refusal !== undefined) ctx.addIssue({ code: 'custom', path: ['url'], message: refusal });
});

/** Why a URL entered for an MCP connection is refused, or undefined. */
export function mcpUrlRefusal(url: string): string | undefined {
  return urlRefusal(url, { label: LABEL });
}

/** How long a 429 without a usable Retry-After holds the connection. */
const THROTTLE_MS = 1_000;

/** The fetch one install's requests go through: counted, limited under the
 *  module's declared limits (and any throttle its server answered), then guarded. */
export function mcpServerFetch(install: BuiltinInstall, definition: Pick<ModuleDefinition, 'limits'>): typeof fetch {
  const guarded = publicFetch();
  const caller: Caller = {
    module: MCP_ADAPTER_TYPE,
    team: install.teamId,
    ...(install.credentialsId !== undefined ? { install: install.credentialsId, credential: install.credentialsId } : {}),
  };
  const request = limitRequest(caller, definition.limits ?? []);
  return async (input, init) => {
    countAdapterCall('remote');
    const response = await limited(limiterSlot(), request, () => guarded(input, init));
    if (response.status === 429) await throttleAfter(limiterSlot(), caller, vendorWaitMs(response) ?? THROTTLE_MS);
    return response;
  };
}
