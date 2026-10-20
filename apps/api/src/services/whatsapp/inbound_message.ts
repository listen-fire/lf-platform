// The `whatsapp_message` work kind: everything the platform's WhatsApp number
// door does with one inbound message. The door writes each message of a Meta
// delivery down as a row before it answers Meta; the dispatch to the sender's
// team, a tapped callback button's fire-and-reply, and the ops notice run when
// that row drains. Work done after the answer would be lost to a restart, a
// deploy or a frozen instance, and Meta would never resend it.

import { z } from 'zod';

import type { WhatsAppMessage } from '../../interfaces/whatsapp/webhook';
import type { WorkHandler } from '../work/kinds';

import { logger } from 'movement-engine/public/log';
import { sendSlackNotification } from '../../lib/slack';
import { registerWorkKinds } from '../work/drain';
import { enqueueWork } from '../work/store';
import { dispatchWhatsappMessage } from './dispatch';
import { resolveWhatsappSender } from './utils';
import {
  defaultWhatsappCallbackResponder,
  handleWhatsappInteractiveReply,
  interactiveReplyOf,
} from '../webhook_sync/whatsapp_callback_door';

declare module '../work/kinds' {
  interface UnitWorkKinds {
    whatsapp_message: true;
  }
}

const messageShapeSchema = z.object({ id: z.string().min(1), from: z.string() }).passthrough();

const whatsappMessageRowSchema = z.object({
  message: z.custom<WhatsAppMessage>((value) => messageShapeSchema.safeParse(value).success),
  profileName: z.string().optional(),
  businessNumber: z.string().optional(),
  businessPhoneNumberId: z.string().optional(),
  /** The first message of a delivery's entry: the one the ops notice is
   *  about, so a batch announces once, as it always has. */
  announce: z.boolean(),
});

export type WhatsappMessageRow = z.infer<typeof whatsappMessageRowSchema>;

/** The rows a Meta delivery becomes: one per message, in delivery order. A
 *  delivery that carries no messages (delivery receipts, another Meta product)
 *  becomes none. */
export function whatsappMessageRowsOf(body: {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field: string;
      value: {
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string } }>;
        messages?: WhatsAppMessage[];
      };
    }>;
  }>;
}): WhatsappMessageRow[] {
  if (body.object !== 'whatsapp_business_account') return [];
  const rows: WhatsappMessageRow[] = [];
  for (const entry of body.entry ?? []) {
    const change = entry.changes?.[0];
    if (change?.field !== 'messages') continue;
    const { value } = change;
    const profileName = value.contacts?.[0]?.profile?.name;
    const businessNumber = value.metadata?.display_phone_number;
    const businessPhoneNumberId = value.metadata?.phone_number_id;
    (value.messages ?? []).forEach((message, index) => {
      rows.push({
        message,
        ...(profileName !== undefined ? { profileName } : {}),
        ...(businessNumber !== undefined ? { businessNumber } : {}),
        ...(businessPhoneNumberId !== undefined ? { businessPhoneNumberId } : {}),
        announce: index === 0,
      });
    });
  }
  return rows;
}

/** Write one message down. Keyed on its wamid, which Meta keeps across its
 *  resends, so a resend that lands while the row still waits folds onto it.
 *  A resend that lands after the row ran runs it again and finds the trigger
 *  receipts already stored under the same wamid, so nothing dispatches twice. */
export async function enqueueWhatsappMessage(row: WhatsappMessageRow): Promise<void> {
  await enqueueWork({ kind: 'whatsapp_message', key: `whatsapp_message:${row.message.id}`, payload: row });
}

/**
 * One message, in an order that keeps a retry clean: the dispatch first (its
 * receipts make a rerun a no-op, and a failure throws so the row retries before
 * anything the tapper or ops can see has happened), then a tapped callback
 * button's fire and threaded reply, then the ops notice. Those two never throw.
 */
async function runWhatsappMessage(row: WhatsappMessageRow): Promise<void> {
  const { message, profileName, businessNumber, businessPhoneNumberId } = row;
  await dispatchWhatsappMessage({ message, profileName, businessNumber, businessPhoneNumberId });
  logger.info('Dispatched WhatsApp message', { messageId: message.id });

  // A tap is an ordinary message carrying `interactive.button_reply`; dispatch
  // above drops it as unclassified, so only the callback door acts on it.
  const reply = interactiveReplyOf(message, businessPhoneNumberId);
  if (reply !== undefined) {
    const result = await handleWhatsappInteractiveReply({ reply, responder: defaultWhatsappCallbackResponder() });
    if (result !== null) logger.info('Handled WhatsApp interactive callback reply', result);
  }

  if (row.announce) {
    try {
      await announceToOps(message);
    } catch (error) {
      logger.warn('[whatsapp/webhook] ops notice failed', {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function announceToOps(message: WhatsAppMessage): Promise<void> {
  const sender = await resolveWhatsappSender(message.from);
  const senderLabel = sender.displayName ? `${sender.displayName} (${message.from})` : `Unknown user: ${message.from}`;
  await sendSlackNotification({
    type: 'OVI',
    teamId: sender.teamId,
    text: `:speech_balloon: New WhatsApp message from: ${senderLabel}\n*Message*: "${describeContent(message)}"`,
    opsTitle: `New WhatsApp message from ${sender.displayName ?? message.from}`,
  });
}

function describeContent(message: WhatsAppMessage): string {
  if (message.text?.body) return message.text.body;
  if (message.button) return `Template Button: ${message.button.text} (${message.button.payload})`;
  if (message.interactive?.button_reply) {
    return `Interactive Button: ${message.interactive.button_reply.title} (${message.interactive.button_reply.id})`;
  }
  const contact = message.contacts?.[0];
  if (contact) return `Contact Card: ${contact.name.formatted_name}${contact.org?.company ? ` @ ${contact.org.company}` : ''}`;
  return '[No text content]';
}

// A store outage backs a row off to minutes between attempts; past this many
// the message is given up on, loudly, rather than retried forever.
const MAX_WHATSAPP_MESSAGE_ATTEMPTS = 10;

export const whatsappMessageHandler: WorkHandler = {
  async run(payload, ctx) {
    const parsed = whatsappMessageRowSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error('[whatsapp/webhook] unreadable message row dropped', { error: parsed.error.message });
      return;
    }
    try {
      await runWhatsappMessage(parsed.data);
    } catch (error) {
      if (ctx.attempts < MAX_WHATSAPP_MESSAGE_ATTEMPTS) throw error;
      logger.error('[whatsapp/webhook] giving up on the message', {
        messageId: parsed.data.message.id,
        attempts: ctx.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

export function registerWhatsappMessageWork(): void {
  registerWorkKinds([{ kind: 'whatsapp_message', handler: whatsappMessageHandler }]);
}
