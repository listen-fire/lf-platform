// The email credential: the provider keys a host holds. Reading attachment
// bytes takes the key of the provider that stored them; sending takes a key
// and an address to send as. Every field is optional because a host may use
// one provider, the other, or only receive.

import { z } from 'zod';

import type { ModuleContext } from 'module-kit';
import type { WireCredentialDeclarationShape } from 'engine-contracts';

import type { EmailProviderAccess } from './providers';
import type { OutboundEmailMessager, OutboundEmailProvider } from './send/interface';

import { OutboundMailgunAdapter } from './send/mailgun';
import { OutboundResendAdapter } from './send/resend';
import { UnconfiguredOutboundEmailAdapter } from './send/unconfigured';

export const EMAIL_CREDENTIAL: WireCredentialDeclarationShape = {
  name: 'email',
  kind: 'static',
  fields: [
    { name: 'resendApiKey', label: 'Resend API key', optional: true },
    { name: 'resendBaseUrl', label: 'Resend API base URL', secret: false, optional: true },
    { name: 'mailgunApiKey', label: 'Mailgun API key', optional: true },
    { name: 'mailgunSendingDomain', label: 'Mailgun sending domain', secret: false, optional: true },
    { name: 'mailgunBaseUrl', label: 'Mailgun API base URL', secret: false, optional: true },
    { name: 'from', label: 'Address mail is sent as', secret: false, optional: true },
    { name: 'fromName', label: 'Name mail is sent as', secret: false, optional: true },
  ],
};

/** A blank field is an absent one: a connect form stores what was left empty. */
const present = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value));

export const emailCredentialFields = z.object({
  resendApiKey: present,
  resendBaseUrl: present,
  mailgunApiKey: present,
  mailgunSendingDomain: present,
  mailgunBaseUrl: present,
  from: present,
  fromName: present,
});
export type EmailCredentialFields = z.infer<typeof emailCredentialFields>;

/** What reaching the providers takes, from the module context, read per call:
 *  a credential edited between calls is seen by the next one. No readable
 *  credential is no keys: each provider then refuses by name when it is
 *  needed. `ctx.config.baseUrlOverride` (the dev loop's fake) is Resend's. */
export async function emailAccessFrom(ctx: ModuleContext): Promise<EmailProviderAccess> {
  let fields: unknown;
  try {
    fields = await ctx.credential.fields();
  } catch {
    fields = {};
  }
  const parsed = emailCredentialFields.safeParse(fields);
  const read = parsed.success ? parsed.data : emailCredentialFields.parse({});
  const resendBaseUrl = ctx.config.baseUrlOverride ?? read.resendBaseUrl;
  return {
    fetch: ctx.fetch,
    ...(read.resendApiKey !== undefined ? { resendApiKey: read.resendApiKey } : {}),
    ...(resendBaseUrl !== undefined ? { resendBaseUrl } : {}),
    ...(read.mailgunApiKey !== undefined ? { mailgunApiKey: read.mailgunApiKey } : {}),
    ...(read.mailgunSendingDomain !== undefined ? { mailgunSendingDomain: read.mailgunSendingDomain } : {}),
  };
}

/**
 * A sender over an email credential: Resend when it holds a Resend key,
 * Mailgun when it holds a Mailgun key and domain (the precedence the
 * deployment choice has, `send/choose.ts`), else one that refuses every send.
 * Either provider needs `from`, the address the mail is sent as; nothing has
 * a safe default for it.
 */
export function emailSenderFrom(
  fields: EmailCredentialFields,
  options: { fetch?: typeof fetch } = {},
): { provider: OutboundEmailProvider; sender: OutboundEmailMessager } {
  const defaultSender = { email: fields.from ?? '', username: fields.fromName ?? '' };
  if (fields.from !== undefined && fields.resendApiKey !== undefined) {
    return {
      provider: 'resend',
      sender: new OutboundResendAdapter({
        resendApiKey: fields.resendApiKey,
        defaultSender,
        ...(fields.resendBaseUrl !== undefined ? { apiBaseUrl: fields.resendBaseUrl } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      }),
    };
  }
  if (fields.from !== undefined && fields.mailgunApiKey !== undefined && fields.mailgunSendingDomain !== undefined) {
    return {
      provider: 'mailgun',
      sender: new OutboundMailgunAdapter({
        mailgunApiKey: fields.mailgunApiKey,
        sendingDomain: fields.mailgunSendingDomain,
        defaultSender,
        ...(fields.mailgunBaseUrl !== undefined ? { apiBaseUrl: fields.mailgunBaseUrl } : {}),
      }),
    };
  }
  return { provider: 'unconfigured', sender: new UnconfiguredOutboundEmailAdapter() };
}
