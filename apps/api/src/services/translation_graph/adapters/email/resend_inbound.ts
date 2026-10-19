// The Resend door's platform half: the webhook secret and the router the
// module's admission (`admitResendMail`) is handed, and the Resend API the
// handler fetches the message through. Both are the platform's environment;
// what a delivery and a message ARE is the module's (@lf/email).

import type { Request } from 'express';
import type { InboundEmailDecision, ResendStore } from '@listen-fire/email';

import { DEFAULT_API_BASE_URL, admitResendMail, fetchResendEmailPayload as fetchWith } from '@listen-fire/email';
import { getEnvVar } from '../../../../lib/utils/environment';
import { routeInboundEmail } from './inbound_door';

const resendMailStore: ResendStore = {
  route: routeInboundEmail,
  resendWebhookSecret: () => process.env.RESEND_WEBHOOK_SECRET,
};

/** The Resend door over the platform's store. The raw bytes are `req.body`
 *  when the route was mounted with the raw parser; otherwise the signature can
 *  never be checked. */
function verifyResendInboundRequest(req: Request): Promise<InboundEmailDecision> {
  return admitResendMail(resendMailStore, {
    rawBody: Buffer.isBuffer(req.body) ? req.body : null,
    headers: req.headers,
  });
}

/** The message behind a delivery, through the platform's Resend account. */
function fetchResendEmailPayload(emailId: string): Promise<Record<string, unknown>> {
  const apiKey = getEnvVar('RESEND_API_KEY', {
    devDefault: 'fake_resend_key',
    because: 'inbound Resend mail carries only ids — the body and the attachments are fetched with it',
  });
  const baseUrl = process.env.RESEND_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  return fetchWith({ apiKey, baseUrl, fetch: (input, init) => fetch(input, init) }, emailId);
}

export { fetchResendEmailPayload, verifyResendInboundRequest };
