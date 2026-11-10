// What every tRPC route that creates a connection asks first: who may use it,
// as the caller states it, decided before anything is stored.

import { TRPCError } from '@trpc/server';
import { currentPrincipal } from 'principal';

import type { Grantee } from '../../../services/access/statement';

import { StatementRefusedError, checkConnectionCreation } from '../../../services/access/decide';
import { MISSING_USE_REFUSAL } from '../../../services/access/stated_input';

/** The caller's use statement for a connection they create on this team, or the refusal that names what is wrong with it. */
export async function useForNewConnection(asked: { teamId: string; use: readonly Grantee[] | undefined }): Promise<readonly Grantee[]> {
  if (asked.use === undefined) throw new TRPCError({ code: 'BAD_REQUEST', message: MISSING_USE_REFUSAL });
  try {
    await checkConnectionCreation(currentPrincipal(), { teamId: asked.teamId, use: asked.use });
  } catch (error) {
    if (error instanceof StatementRefusedError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    throw error;
  }
  return asked.use;
}
