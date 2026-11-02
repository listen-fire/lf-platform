// Evertrace's legacy line: the module's adapter (@lf/evertrace), over
// the credential path the platform used before modules (client.ts). Kept so
// the `BUILTIN_MODULES` line for Evertrace can go back to `legacy` in one edit
// while the module line is new; remove it with the line once the module line
// has soaked.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { EvertraceAdapter, type EvertraceClientSource } from '@listen-fire/evertrace';
import { logger } from 'movement-engine/public/log';
import { resolveEvertraceClient } from './client';

function legacyClient(input: { teamId: TeamId; credentialsId?: string }): EvertraceClientSource {
  return async () => {
    const client = await resolveEvertraceClient(input);
    if (!client) {
      throw new Error(
        `EvertraceAdapter: no usable Evertrace credential for team ${input.teamId} ` +
          `(credentialsId=${input.credentialsId ?? 'unset'}). Connect Evertrace.`,
      );
    }
    return client;
  };
}

export function createEvertraceAdapter(input: { teamId: TeamId; credentialsId?: string }): EvertraceAdapter {
  return new EvertraceAdapter(legacyClient(input));
}
