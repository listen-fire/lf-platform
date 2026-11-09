// Whose catalog an assembly is for. Its own module, beside the catalog rather
// than in it, so a test that stands in for the catalog keeps these.

import { currentPrincipal, type Principal } from 'principal';

/**
 * Whose catalog this is. A person authoring, describing or reading sees only
 * the connections they may use, since a dry run or a describe reads what is
 * in the connection. A run is the automation's own act and sees every
 * connection its team holds.
 */
export type CatalogAudience = { for: Principal } | { for: 'run' };

/** The person making this request, as a catalog's audience. */
export function callerAudience(): CatalogAudience {
  return { for: currentPrincipal() };
}

/** Two requests may share a cached catalog only when they would see the same connections. */
export function audienceKey(audience: CatalogAudience): string {
  if (audience.for === 'run') return 'run';
  const { userId, teamId, access, pinnedTeamId } = audience.for;
  return JSON.stringify([userId ?? null, teamId, access, pinnedTeamId]);
}

