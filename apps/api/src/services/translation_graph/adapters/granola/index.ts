// Granola's legacy line: the module's adapter (@lf/granola), over the
// credential path the platform used before modules (client.ts). Kept so the
// `BUILTIN_MODULES` line for Granola can go back to `legacy` in one edit while
// the module line is new; remove it with the line once the module line has
// soaked.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { GranolaAdapter, type GranolaClientSource } from '@listen-fire/granola';
import { resolveGranolaClient } from './client';

function legacyClient(input: { teamId: TeamId; credentialsId?: string }): GranolaClientSource {
  return async () => {
    const client = await resolveGranolaClient(input);
    if (!client) {
      throw new Error(
        `GranolaAdapter: no usable Granola credential for team ${input.teamId} ` +
          `(credentialsId=${input.credentialsId ?? 'unset'}). Connect Granola.`,
      );
    }
    return client;
  };
}

export function createGranolaAdapter(input: { teamId: TeamId; credentialsId?: string }): GranolaAdapter {
  return new GranolaAdapter(legacyClient(input));
}
