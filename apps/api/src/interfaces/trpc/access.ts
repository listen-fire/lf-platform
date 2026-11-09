// The access decision as a tRPC procedure answers it (`../access_route.ts`).

import { TRPCError } from '@trpc/server';
import { neverAsAny } from 'movement-engine/public/types';

import { READ_ONLY_MESSAGE, refusalOn } from '../access_route';

/**
 * Whether a change must answer as if the automation were missing: the caller
 * may not see it. A caller who may see it but not change it is refused
 * outright, since the name is no secret to them.
 */
async function cannotChange(automationId: string | null): Promise<boolean> {
  const refusal = await refusalOn({ automationId, verb: 'write' });
  switch (refusal) {
    case undefined:
      return false;
    case 'unseen':
      return true;
    case 'read_only':
      throw new TRPCError({ code: 'FORBIDDEN', message: READ_ONLY_MESSAGE });
    default:
      return neverAsAny(refusal);
  }
}

export { cannotChange };
