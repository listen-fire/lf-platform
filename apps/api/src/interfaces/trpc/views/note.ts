import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { NOTION_PAGE_ID_REGEX, getNotionPageContent } from '../../../lib/notion';
import { NotionTokenService } from '../../../services/notion_token';
import { notionToMarkdown } from '../../../lib/notion/parser';

import { NOTION_REGEX } from 'engine-contracts/document_sources';

const noteRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    extractNotionpPageContent: userProcedure
      .input(
        z.object({
          url: z.string(),
        }),
      )
      .mutation(async ({ input: { url } }) => {
        const ctx = currentContext();
        if (!NOTION_REGEX.test(url)) return null;

        const result = url.match(NOTION_PAGE_ID_REGEX);
        if (result && result.length > 0) {
          const notionAccessToken = await NotionTokenService.getByTeamId(ctx.user.teamId);
          if (!notionAccessToken) {
            throw new Error('Notion token not found');
          }

          try {
            const content = await getNotionPageContent({
              pageId: result[0],
              secret: notionAccessToken.token,
            });
            return await notionToMarkdown(content);
          } catch (_error) {
            return null;
          }
        }
        return null;
      }),
  });
};

export { noteRouter };
