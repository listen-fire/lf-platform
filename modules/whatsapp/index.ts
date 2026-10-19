// `@lf/whatsapp`: WhatsApp (the Meta Cloud API) as a module. The host hands it
// the install's credential (a Meta access token, the number it sends from,
// optionally a second number, Meta's base URL and a Twilio account whose
// media it owns), a fetch, and its files; the module builds a Meta client per
// call from them, so a credential edited between calls is read by the next
// one. `ctx.config.baseUrlOverride` (the dev loop's fake) wins over the
// credential's own base URL.
//
// Which Meta app speaks for an install is the host's call, made in the
// credential it hands over: the platform hands its one shared app (the
// deployment's `WHATSAPP_*`), lf the user's own. Who may message it (OTP,
// phone links, team membership) stays with the host's doors.

import { z } from 'zod';

import { defineModule, type AdapterModuleDefinition, type ModuleContext } from 'module-kit';

import { WhatsappAdapter, issuedTwilioMedia, type WhatsappSources } from './adapter';
import { META_GRAPH_BASE_URL, whatsappNumbers } from './client';
import { whatsappManifest } from './manifest';

/** The credential's fields. */
const whatsappCredential = z.object({
  accessToken: z.string(),
  phoneNumberId: z.string(),
  movementsPhoneNumberId: z.string().optional(),
  baseUrl: z.string().url().optional(),
  twilioAccountSid: z.string().optional(),
});

/** What a host knows that the module cannot. */
export interface WhatsappHost {
  /** The number people message, quoted in the manifest; none where it is
   *  each user's own. */
  movementsNumber?: string | null;
  /** Whether a URL is one the host exposed a file at: the platform's Meta door
   *  downloads each media item and hands the adapter such a URL. */
  exposedFileUrl?(url: string): boolean;
}

/** The adapter's sources over a module context. */
export function whatsappSourcesFrom(ctx: ModuleContext, host: WhatsappHost = {}): WhatsappSources {
  const credential = async () => whatsappCredential.parse(await ctx.credential.fields());
  return {
    sender: async (phoneNumberId) => {
      const fields = await credential();
      return whatsappNumbers({
        accessToken: fields.accessToken,
        phoneNumberId: fields.phoneNumberId,
        ...(fields.movementsPhoneNumberId !== undefined ? { movementsPhoneNumberId: fields.movementsPhoneNumberId } : {}),
        graphBaseUrl: ctx.config.baseUrlOverride ?? fields.baseUrl ?? META_GRAPH_BASE_URL,
        fetch: ctx.fetch,
        log: ctx.log,
      })(phoneNumberId);
    },
    issued: async (handle) => {
      if (host.exposedFileUrl?.(handle) === true) return true;
      let account: string | undefined;
      try {
        account = (await credential()).twilioAccountSid;
      } catch {
        // No readable credential: no Twilio account, so no Twilio media is its.
      }
      return issuedTwilioMedia(handle, account);
    },
    fetch: ctx.fetch,
    readFile: (file) => ctx.files.read(file),
    log: ctx.log,
  };
}

/** `@lf/whatsapp` for a host that knows what `host` says. */
export function whatsappModuleWith(host: WhatsappHost): AdapterModuleDefinition {
  return defineModule({
    kind: 'adapter',
    name: '@lf/whatsapp',
    manifest: whatsappManifest(host.movementsNumber ?? null),
    credentials: [
      {
        name: 'whatsapp',
        kind: 'static',
        fields: [
          { name: 'accessToken', label: 'Meta access token' },
          { name: 'phoneNumberId', label: 'Phone number id (the number it sends from)', secret: false },
          { name: 'movementsPhoneNumberId', label: 'A second phone number id, in the same Meta app', secret: false, optional: true },
          { name: 'baseUrl', label: 'Graph API base URL', secret: false, optional: true },
          { name: 'twilioAccountSid', label: 'Twilio account SID (its media are this install’s)', secret: false, optional: true },
        ],
      },
    ],
    create: (ctx) => new WhatsappAdapter(whatsappSourcesFrom(ctx, host)),
  });
}

/** The module for a host with no shared number and no exposed files (lf). */
export const whatsappModule = whatsappModuleWith({});

export default whatsappModule;

export * from './adapter';
export * from './client';
export * from './handbook_section';
export * from './inbound';
export * from './manifest';
export * from './phone';
export * from './types';
