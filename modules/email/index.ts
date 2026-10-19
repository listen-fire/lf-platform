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

import type { EventType, InboundCheck, InboundCheckInput } from 'movement-engine/public/adapter';

import { EmailAdapter, type EmailSources } from './adapter';
import { EMAIL_CREDENTIAL, emailAccessFrom } from './credential';
import { EMAIL_INBOUND_TAG, checkEmailInbound, type EmailInboundSources } from './inbound/check';
import { EMAIL_MANIFEST } from './manifest';
import { fetchEmailAttachment } from './providers';
import { EMAIL_RECORD_TYPE_ID } from './types';

/** The adapter's sources over a module context. */
export function emailSourcesFrom(ctx: ModuleContext): EmailSources {
  return {
    fetchAttachment: async (handle) => fetchEmailAttachment(handle, await emailAccessFrom(ctx)),
  };
}

/** The email adapter as the module serves it: it also checks the mail a
 *  provider posts to its door, and types what that mail becomes. The
 *  platform's own mail doors keep the plain adapter. */
export class InboundEmailAdapter extends EmailAdapter {
  constructor(
    sources: EmailSources,
    private readonly inbound: EmailInboundSources,
  ) {
    super(sources);
  }

  async checkInbound(input: InboundCheckInput): Promise<InboundCheck> {
    return checkEmailInbound(input, this.inbound);
  }

  async listEventTypes(): Promise<EventType[]> {
    return [{ tag: EMAIL_INBOUND_TAG, positionType: EMAIL_RECORD_TYPE_ID }];
  }
}

export const emailModule = defineModule({
  kind: 'adapter',
  name: '@lf/email',
  manifest: EMAIL_MANIFEST,
  credentials: [EMAIL_CREDENTIAL],
  // Mailgun and Resend each sign their own way, neither a declared scheme.
  inbound: { providerKey: 'email', scheme: 'module' },
  create: (ctx) => new InboundEmailAdapter(emailSourcesFrom(ctx), { access: () => emailAccessFrom(ctx) }),
});

export default emailModule;

export * from './adapter';
export * from './address';
export * from './credential';
export * from './inbound/check';
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
