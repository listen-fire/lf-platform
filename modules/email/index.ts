// `@lf/email`: inbound email as a module. Mail reaches a movement through an
// inbound address (`<local>+<key>@<domain>`, `address.ts`) at whichever
// provider the deployment receives with — Mailgun or Resend — and every email
// has the same fields, edges and attachments whichever carried it.
//
// The module is everything about the mail itself: the adapter, each
// provider's wire shape and signature (`inbound/`), fetching what Resend's
// notification leaves out (`resend_inbound.ts`), a stored attachment's bytes
// (`providers.ts`) and the senders (`send/`). The host keeps what is about
// its own people: whose team a believed message is for and which trigger
// answers (an `InboundMailRouter` it hands the doors), the doors' routes, and
// any record of what it sent.
//
// The host hands the module the provider keys as the install's credential
// (`credential.ts`): the platform from its environment, lf from the user's own
// Resend or Mailgun account.

import { defineModule, type ModuleContext } from 'module-kit';

import { EmailAdapter, type EmailSources } from './adapter';
import { EMAIL_CREDENTIAL, emailAccessFrom } from './credential';
import { EMAIL_MANIFEST } from './manifest';
import { fetchEmailAttachment } from './providers';

/** The adapter's sources over a module context. */
export function emailSourcesFrom(ctx: ModuleContext): EmailSources {
  return {
    fetchAttachment: async (handle) => fetchEmailAttachment(handle, await emailAccessFrom(ctx)),
  };
}

export const emailModule = defineModule({
  kind: 'adapter',
  name: '@lf/email',
  manifest: EMAIL_MANIFEST,
  credentials: [EMAIL_CREDENTIAL],
  create: (ctx) => new EmailAdapter(emailSourcesFrom(ctx)),
});

export default emailModule;

export * from './adapter';
export * from './address';
export * from './credential';
export * from './inbound/mail';
export * from './manifest';
export * from './providers';
export * from './resend';
export * from './resend_inbound';
export * from './send/choose';
export * from './send/fake';
export * from './send/interface';
export * from './send/mailgun';
export * from './send/resend';
export * from './send/unconfigured';
export * from './types';
