import { z } from 'zod';

import { currentContext } from '../../../services/context';
import {
  startPhoneVerification,
  confirmPhoneVerification,
} from '../../../services/whatsapp/phone_verification';
import { whatsappLinkVerification } from '../../../services/whatsapp/phone_verification/link_verification';
import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { UserService } from '../../../services/user';
import { WHATSAPP_MOVEMENTS_NUMBER } from '../../../services/translation_graph/adapters/whatsapp';
import { LISTEN_FIRE_VERSION } from '../../../constants';

const userSettingsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    // Facts about the INSTALLATION rather than about the user: the release it
    // is running, and the number a person messages to reach it. Both are read
    // by the settings page and neither depends on who is asking, so they are
    // one query — a second one-off per deployment fact is how a settings page
    // ends up making five round trips to render a footer.
    //
    // `whatsappNumber` is null on an install with no WhatsApp sender
    // registered, and the WhatsApp section has nothing to offer then.
    // `whatsappLinkVerification` says whether linking a number sends a code
    // (`otp`) or links it on the spot (`trust`), so the page can label its
    // button before anyone presses it.
    getDeployment: userProcedure.query(() => ({
      version: LISTEN_FIRE_VERSION,
      whatsappNumber: WHATSAPP_MOVEMENTS_NUMBER,
      whatsappLinkVerification: whatsappLinkVerification(),
    })),

    getPhoneNumber: userProcedure.query(async () => {
      const ctx = currentContext();
      const phoneNumber = await ctx.prisma.phoneNumber.findFirst({
        where: { userId: ctx.user.id },
      });
      return phoneNumber;
    }),

    updatePhoneNumber: userProcedure.input(z.string()).mutation(async ({ input: phoneNumber }) => {
      const ctx = currentContext();
      const res = await UserService.addPhoneNumber({ userId: ctx.user.id, phoneNumber });
      return res;
    }),

    // Send a WhatsApp verification code to the number the user is claiming —
    // or, on a deployment that trusts the claim, link it straight away.
    startPhoneVerification: userProcedure
      .input(z.object({ phoneNumber: z.string().min(6) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        return startPhoneVerification({ userId: ctx.user.id, phoneNumber: input.phoneNumber });
      }),

    // Confirm the code — on success the phone becomes a verified, routable link.
    confirmPhoneVerification: userProcedure
      .input(z.object({ phoneNumber: z.string().min(6), code: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        return confirmPhoneVerification({
          userId: ctx.user.id,
          phoneNumber: input.phoneNumber,
          code: input.code,
        });
      }),

    getEmails: userProcedure.query(async () => {
      const ctx = currentContext();
      const emails = await ctx.prisma.userEmail.findMany({
        where: {
          userId: ctx.user.id,
        },
      });
      return emails.map((email) => ({
        id: email.id,
        email: email.email,
        isPrimary: email.isPrimary,
      }));
    }),
    updateUsername: userProcedure
      .input(
        z.object({
          username: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        await ctx.prisma.user.update({
          where: {
            id: ctx.user.id,
          },
          data: {
            username: input.username,
          },
        });

        return { success: true };
      }),
  });
};

export { userSettingsRouter };
