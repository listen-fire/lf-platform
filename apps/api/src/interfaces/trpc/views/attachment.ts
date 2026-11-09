import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { DocumentService } from '../../../services/document';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { decidesEach, type Decision } from '../../access_route';

const attachmentRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    getDownloadLinkByDocumentId: userProcedure
      .input(z.object({ documentId: z.string() }))
      .query(async ({ input: { documentId } }) => {
        const ctx = currentContext();
        const document = await ctx.prisma.document.findFirst({
          where: {
            id: documentId,
            teamId: ctx.user.teamId,
          },
        });
        if (!document) {
          throw new Error(`[${ctx.user.teamId}] No document found with id ${documentId}`);
        }
        const url = await DocumentService.getDownloadUrl(documentId);
        return {
          name: document.description,
          url,
        };
      }),
  });
};

const EXEMPTION: Decision = { exempt: 'a team document, no automation' };

decidesEach('attachments', {
  getDownloadLinkByDocumentId: EXEMPTION,
});

export { attachmentRouter };
