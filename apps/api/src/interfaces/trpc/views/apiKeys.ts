import { z } from 'zod';

import { trpc } from '../trpc';
import { ApiKeyService } from '../../../services/api_key';

const apiKeysRouter = (procedure: typeof trpc.procedure) => {
  return trpc.router({
    list: procedure.query(async () => {
      return ApiKeyService.listByTeam();
    }),

    create: procedure
      .input(
        z.object({
          name: z.string().min(1),
          scopes: z.array(z.string()).optional(),
          expiresAt: z.date().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const result = await ApiKeyService.create(input);
        return {
          id: result.id,
          name: result.name,
          keyPrefix: result.keyPrefix,
          key: result.key,
          scopes: result.scopes,
          expiresAt: result.expiresAt,
          createdAt: result.createdAt,
        };
      }),

    revoke: procedure
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        await ApiKeyService.revoke(input.id);
        return { success: true };
      }),
  });
};

export { apiKeysRouter };
