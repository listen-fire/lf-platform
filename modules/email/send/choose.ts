// Which outbound email adapter a deployment gets, as a decision rather than as
// the order of an if-chain.
//
// The precedence matches inbound's (`providers.ts`): Resend wins when both
// are configured, so a deployment sends through the same company its mail
// arrives at. Splitting the choice out of the composition root is what lets
// all four outcomes be asserted without importing every service in the
// process.

import type { OutboundEmailProvider } from './interface';

/**
 * Development gets the fake outbox whatever is configured — a developer's
 * `.env` carries a live key for convenience, and that must never become a
 * reason for a local run to send real mail.
 */
function chooseOutboundEmailProvider(
  env: NodeJS.ProcessEnv = process.env,
): OutboundEmailProvider {
  const environment: string = env.NODE_ENV ?? '';
  if (environment !== 'production' && environment !== 'staging') return 'fake';

  // Nothing here has a safe default. The from-address is what a deployment
  // sends AS, and Mailgun additionally needs the domain it has verified —
  // guessing either sends mail as somebody else, or not at all.
  if (!env.OUTBOUND_EMAIL_FROM) return 'unconfigured';
  if (env.RESEND_API_KEY) return 'resend';
  if (env.MAILGUN_API_KEY && env.MAILGUN_SENDING_DOMAIN) return 'mailgun';
  return 'unconfigured';
}

export { chooseOutboundEmailProvider };
