// WhatsApp (Meta Cloud API) webhook provider — registration metadata only.
// Meta POSTs its `messages` envelope to the webhook door, which verifies the
// X-Hub-Signature-256 HMAC (services/inbound/legacy_signature_headers.ts) and
// hands the body to the adapter's `preprocessInbound`. Parsing lives with the
// module (`whatsappInboundEvents` in @lf/whatsapp's inbound.ts, which the
// platform's Meta door also classifies with).

import type { WebhookProvider, WebhookRegistration } from './interface';

export const whatsappProvider: WebhookProvider = {
  // Meta webhooks are configured in the Meta App dashboard out of band, not via
  // an Listen-Fire API call — mirror the Telegram/Slack manual stance.
  canRegisterViaApi: false,

  defaultEventTypes: ['message'],

  setupInstructions: [
    'WhatsApp (Meta Cloud API) webhooks are configured in the Meta App dashboard:',
    '1. In WhatsApp > Configuration, set the Callback URL to the Webhook URL above',
    '   and the Verify Token to WHATSAPP_WEBHOOK_VERIFY_TOKEN.',
    '2. Subscribe to the `messages` field. Meta signs deliveries with your App',
    '   Secret (X-Hub-Signature-256), verified here.',
  ].join('\n'),

  async registerSubscription(): Promise<WebhookRegistration> {
    // Manual mode — Meta is configured in its dashboard; the subscription is
    // identified by its row id (the path segment in the webhook URL).
    return { secret: '' };
  },
};
