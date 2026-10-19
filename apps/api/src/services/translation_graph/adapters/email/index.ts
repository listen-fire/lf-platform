// Email's legacy line: the module's adapter (@lf/email) over the platform's
// own provider keys, read from its environment exactly as before the module.
// Kept so the `BUILTIN_MODULES` line for email can go back to `legacy` in one
// edit while the module line is new; remove it with the line once the module
// line has soaked.
//
// The keys themselves are the platform's either way: the module line is handed
// the same environment as the install's credential (`platformEmailCredential`).
// Nobody connects an email credential on the platform.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { CredentialFields, ModuleCredential } from 'module-kit';

import {
  EmailAdapter as EmailModuleAdapter,
  fetchEmailAttachment,
  emailCredentialFields,
  type EmailProviderAccess,
} from '@listen-fire/email';

export {
  EMAIL_ADAPTER_ALIASES,
  EMAIL_ADAPTER_NAMES,
  EMAIL_ADAPTER_TYPE,
  EMAIL_ATTACHMENTS_FIELD,
  EMAIL_ATTACHMENT_DISPLAY_NAME,
  EMAIL_ATTACHMENT_TYPE_ID,
  EMAIL_MANIFEST,
  EMAIL_RECORD_TYPE_ID,
  normaliseInboundEmailPayload,
  type EmailAttachment,
  type EmailPayload,
} from '@listen-fire/email';

/** A key as the code before the module read it: the development stand-in
 *  everywhere but production, so the dev loop's fakes verify. */
function keyOrDevDefault(env: NodeJS.ProcessEnv, name: string, devDefault: string): string | undefined {
  return env[name] ?? (env.NODE_ENV !== 'production' ? devDefault : undefined);
}

/**
 * The platform's provider keys as the email credential's fields, read now from
 * its environment. A key that is missing is a field that is absent: a
 * deployment that receives through one provider still starts, and only a call
 * that needs the other refuses.
 */
export function platformEmailCredentialFields(env: NodeJS.ProcessEnv = process.env): CredentialFields {
  const fields: Record<string, string | undefined> = {
    resendApiKey: keyOrDevDefault(env, 'RESEND_API_KEY', 'fake_resend_key'),
    resendBaseUrl: env.RESEND_API_BASE_URL,
    mailgunApiKey: keyOrDevDefault(env, 'MAILGUN_API_KEY', 'fake_mailgun_key'),
    mailgunSendingDomain: env.MAILGUN_SENDING_DOMAIN,
    mailgunBaseUrl: env.MAILGUN_API_BASE_URL,
    from: env.OUTBOUND_EMAIL_FROM,
    fromName: env.OUTBOUND_EMAIL_FROM_NAME,
  };
  return Object.fromEntries(Object.entries(fields).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));
}

/** The module line's credential: the platform's environment, never stored and
 *  never written back. */
export function platformEmailCredential(): ModuleCredential {
  return {
    name: 'email',
    fields: async () => platformEmailCredentialFields(),
    update: async () => {
      throw new Error("email: the platform's provider keys are its environment; a module does not write them back");
    },
  };
}

/** Global fetch, looked up per call (so a test's stub is seen). */
const platformFetch: typeof fetch = (input, init) => fetch(input, init);

function platformEmailAccess(): EmailProviderAccess {
  const fields = emailCredentialFields.parse(platformEmailCredentialFields());
  return {
    fetch: platformFetch,
    ...(fields.resendApiKey !== undefined ? { resendApiKey: fields.resendApiKey } : {}),
    ...(fields.resendBaseUrl !== undefined ? { resendBaseUrl: fields.resendBaseUrl } : {}),
    ...(fields.mailgunApiKey !== undefined ? { mailgunApiKey: fields.mailgunApiKey } : {}),
    ...(fields.mailgunSendingDomain !== undefined ? { mailgunSendingDomain: fields.mailgunSendingDomain } : {}),
  };
}

export class EmailAdapter extends EmailModuleAdapter {
  // teamId is accepted for parity with other adapters even though the email
  // adapter has no per-team configuration.
  constructor(readonly teamId: TeamId) {
    super({ fetchAttachment: (handle) => fetchEmailAttachment(handle, platformEmailAccess()) });
  }
}

/** Factory for the registry's legacy line. */
export function createEmailAdapter(input: { teamId: TeamId }): EmailAdapter {
  return new EmailAdapter(input.teamId);
}
