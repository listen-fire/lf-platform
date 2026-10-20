import { type Request, type Response } from 'express';

import { logger } from 'movement-engine/public/log';
import { authorizeUnsignedWebhook } from '../../lib/unsigned_webhooks';
import { verifyWithScheme } from 'movement-engine/public/inbound';
import { enqueueWhatsappMessage, whatsappMessageRowsOf } from '../../services/whatsapp/inbound_message';
import { notifyWork } from '../../services/work/drain';

interface WhatsAppWebhookEntry {
  changes?: Array<{
    field: string;
    value: {
      /** Which of OUR numbers received this — `phone_number_id` selects the
       *  number a reply is sent from (primary vs movements). */
      metadata?: {
        display_phone_number?: string;
        phone_number_id?: string;
      };
      contacts?: Array<{
        wa_id: string;
        profile?: {
          name?: string;
        };
      }>;
      messages?: WhatsAppMessage[];
      statuses?: WhatsAppStatus[];
    };
  }>;
}

/** Which Meta app/number a webhook door serves — its verify token (GET
 *  handshake) and app secret (X-Hub-Signature-256). Both doors share one
 *  implementation; only these differ. */
export interface WhatsappDoorConfig {
  verifyToken: string | undefined;
  appSecret: string | undefined;
}

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: {
    body: string;
  };
  interactive?: {
    type: string;
    button_reply?: {
      id: string;
      title: string;
    };
    list_reply?: {
      id: string;
      title: string;
      description?: string;
    };
  };
  button?: {
    payload: string;
    text: string;
  };
  image?: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  document?: {
    id: string;
    mime_type: string;
    sha256: string;
    filename: string;
    caption?: string;
  };
  audio?: {
    id: string;
    mime_type: string;
    sha256: string;
  };
  video?: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  context?: {
    from: string;
    id: string;
  };
  contacts?: Array<{
    addresses?: Array<{
      city?: string;
      country?: string;
      country_code?: string;
      state?: string;
      street?: string;
      type?: string;
      zip?: string;
    }>;
    birthday?: string;
    emails?: Array<{
      email?: string;
      type?: string;
    }>;
    name: {
      formatted_name: string;
      first_name?: string;
      last_name?: string;
      middle_name?: string;
      suffix?: string;
      prefix?: string;
    };
    org?: {
      company?: string;
      department?: string;
      title?: string;
    };
    phones?: Array<{
      phone?: string;
      wa_id?: string;
      type?: string;
    }>;
    urls?: Array<{
      url?: string;
      type?: string;
    }>;
  }>;
}

interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

interface WhatsAppWebhookBody {
  isTesting?: boolean | null;
  object: string;
  entry?: WhatsAppWebhookEntry[];
}

/**
 * Verify webhook endpoint for WhatsApp Business API
 * This endpoint is called by WhatsApp to verify the webhook URL
 */
const verifyWebhook = (config: WhatsappDoorConfig) => (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Check if a token and mode were sent
  if (mode && token) {
    // Check the mode and token sent are correct
    if (mode === 'subscribe' && token === config.verifyToken) {
      // Respond with 200 OK and challenge token from the request
      res.status(200).send(challenge);
      return;
    } else {
      // Respond with '403 Forbidden' if verify tokens do not match
      res.sendStatus(403);
      return;
    }
  }

  // Respond with '400 Bad Request' if required parameters are missing
  res.sendStatus(400);
};

/** Safe, no-throw extraction for the signature-rejection log below — the body
 *  may not have parsed into the shape we expect, and this must never throw
 *  while handling a rejection. Never log the body itself, only these three
 *  identifying fields. */
function describeWhatsappWebhookRejection(
  body: unknown,
  hasSignature: boolean,
): { hasSignature: boolean; businessAccountId: string | null; phoneNumberId: string | null } {
  const entry = (
    body as
      | { entry?: Array<{ id?: string; changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }> }> }
      | null
      | undefined
  )?.entry?.[0];
  return {
    hasSignature,
    businessAccountId: typeof entry?.id === 'string' ? entry.id : null,
    phoneNumberId: entry?.changes?.[0]?.value?.metadata?.phone_number_id ?? null,
  };
}

/**
 * Receive webhook endpoint for WhatsApp Business API
 * This endpoint receives webhook events from WhatsApp
 */
const receiveWebhook = (config: WhatsappDoorConfig) => async (req: Request, res: Response): Promise<void> => {
  try {
    // Verify the Meta X-Hub-Signature-256 HMAC when an app secret is configured.
    // With NO app secret this used to skip verification entirely, anywhere — so
    // it now falls to the shared no-secret rule every inbound door shares
    // (`lib/unsigned_webhooks`): refused unless the deployment explicitly opted
    // into unsigned deliveries and is not production.
    const appSecret = config.appSecret;
    if (appSecret) {
      const signature = req.get('X-Hub-Signature-256');
      // Meta signs the RAW request bytes, captured as rawBody by the JSON
      // parser's verify hook (lib/middleware/body_parser). The re-serialising
      // fallback only byte-matches plain-ASCII payloads with no `/` in them, so
      // it is for callers that hand the handler a body directly (tests).
      const rawBody: Buffer =
        (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
      if (!signature || !verifyWithScheme('hmac_sha256_hex', { rawBody, headers: { 'x-hub-signature-256': signature }, secret: appSecret })) {
        // A mismatch is silent otherwise: an operator whose deliveries all
        // bounce sees only 401s in the access log, with no way to tell a
        // second Meta app (subscribed to the same WhatsApp Business Account,
        // signing with its own app secret) from a rotated secret.
        logger.warn(
          signature
            ? "[whatsapp/webhook] REJECTING inbound: signature did not verify against WHATSAPP_WEBHOOK_SECRET — the sending Meta app's secret differs (a second app subscribed to this WhatsApp Business Account, or the secret was reset in Meta)"
            : "[whatsapp/webhook] REJECTING inbound: X-Hub-Signature-256 header was absent — the sending Meta app's secret differs (a second app subscribed to this WhatsApp Business Account, or the secret was reset in Meta)",
          describeWhatsappWebhookRejection(req.body, Boolean(signature)),
        );
        res.sendStatus(401);
        return;
      }
    } else if (!authorizeUnsignedWebhook('whatsapp/webhook').authorized) {
      logger.error(
        '[whatsapp/webhook] REJECTING inbound: WHATSAPP_WEBHOOK_SECRET is unset, so ' +
          'nothing proves this delivery came from Meta.',
      );
      res.sendStatus(401);
      return;
    }
    logger.info('Received WhatsApp webhook:', req.body);

    // Durable, then answered: each message is written as a `whatsapp_message`
    // row keyed on its wamid, and the drain does the dispatch, a tapped
    // callback's fire and reply, and the ops notice. Work done after the answer
    // would be lost to a restart, a deploy or a frozen instance. A row that
    // could not be written answers 500, so Meta resends; a resend folds onto
    // the same row or finds its receipts already stored, so it never
    // dispatches twice. A delivery with no messages (delivery receipts, another
    // Meta product) writes nothing and is acked, since Meta retries anything
    // that is not a 200.
    const rows = whatsappMessageRowsOf(req.body as WhatsAppWebhookBody);
    try {
      for (const row of rows) await enqueueWhatsappMessage(row);
    } catch (error) {
      logger.error('[whatsapp/webhook] queueing the delivery failed:', error);
      res.sendStatus(500);
      return;
    }
    if (rows.length > 0) notifyWork();
    res.status(200).send('EVENT_RECEIVED');
  } catch (error: unknown) {
    logger.error('Error processing WhatsApp webhook:', error);
    if (!res.headersSent) res.sendStatus(500);
  }
};

export { verifyWebhook, receiveWebhook, WhatsAppMessage };
