// WhatsApp dumb dispatcher — the agent-free inbound path. An inbound Meta
// message is routed, with NO agent in the middle, to the sender's team: the
// module's arrivals for it (a message, a reaction, a location, each on its own
// edge) are kept as a delivery of the platform's number, judged by every
// WhatsApp listen of the team (inbound/listen_door.ts). A message no listen
// takes is dropped there, logged.
//
// The RECEIVING number gates whether a movement may hear it at all
// (`resolveWhatsappRoute`): once a movements number is configured, the primary
// number reaches no movement.

import { Readable } from 'node:stream';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { MetaWhatsappMessage, WhatsappAttachment, WhatsappPayload } from '@listen-fire/whatsapp';

import { prismaClient } from '../../prisma';
import { Context } from '../context';
import { logger } from 'movement-engine/public/log';
import { DocumentService } from '../document';
import { exposeFile } from '../translation_graph/engine/files/expose';
import { classifyMetaMessage, whatsappInboundArrivals } from '@listen-fire/whatsapp/inbound';
import { WHATSAPP_ADAPTER_TYPE } from '../translation_graph/adapters/whatsapp';
import { deliverArrivals } from '../inbound/listen_door';
import { judgeCarriedPage, withDoorsHeld } from '../inbound/carried_delivery';
import { keptPage } from '../inbound/captured_request';
import { notifyWork } from '../work/drain';
import { teamIdSchema } from '../../lib/team_id';
import { getMetaWhatsappApi, movementsPhoneNumberId } from './metaApi';
import { resolveWhatsappRoute } from './route';
import { isVerifiedLink } from './phone_verification/logic';
import { isTeamMember } from './membership';
import { userPrincipal } from '../principal';

/** The subscription the platform number's deliveries are kept under. */
const WHATSAPP_KIND = 'INBOUND_WHATSAPP';

/** Resolve the sending phone number to an owning team + user. The phone_number
 *  table maps a phone → user; the user's preferred team is the candidate. Two
 *  gates, both required: the link must be VERIFIED (an unverified row, added
 *  without proving ownership, can't capture someone else's WhatsApp traffic),
 *  and the user must be a MEMBER of the team the message would run in.
 *
 *  This is a public webhook door — it never passes through `resolveActingTeam`,
 *  so it applies the same membership rule itself. `default_team_id` names where
 *  a person lands, never where they may act (C-6/D28). */
async function resolveSenderTeam(
  phone: string,
): Promise<{ userId: string; teamId: string } | null> {
  const candidates = [phone, `+${phone.replace(/^\+/, '')}`];
  for (const value of candidates) {
    const row = await prismaClient.phoneNumber.findUnique({ where: { phoneNumber: value } });
    if (row?.userId && isVerifiedLink({ userId: row.userId, verifiedAt: row.verifiedAt })) {
      const user = await prismaClient.user.findUnique({ where: { id: row.userId } });
      if (user) {
        if (await isTeamMember(user.id, user.defaultTeamId)) {
          return { userId: user.id, teamId: user.defaultTeamId };
        }
        logger.info('[whatsapp-dispatch] sender is not a member of their default team', {
          userId: user.id,
          teamId: user.defaultTeamId,
        });
      }
    }
  }
  return null;
}

/** An attachment carrying BOTH a fetchable blob URL (the movement path: the
 *  WhatsappAdapter resolves bytes via `fetchUrlToStream(key)`) AND a durable
 *  document id (the legacy pipeline_input path: `segments` reads
 *  `attachment.documentId`). One shape serves both consumers. */
type ResolvedAttachment = WhatsappAttachment & { documentId?: string };

/**
 * Resolve a Meta message's media. Meta delivers media by id; we download the
 * bytes once, then both (a) persist a durable copy via DocumentService and
 * (b) expose a short-lived fetchable URL via `exposeFile` (→ /api/files/blob/:id).
 * The attachment carries the blob URL as `key`/`url` (so the adapter's
 * `fetchUrlToStream(key)` resolves on the movement path) and the `documentId`
 * (so the legacy pipeline_input consumer reads it).
 */
async function resolveAttachments(
  message: MetaWhatsappMessage,
  teamId: string,
  businessPhoneNumberId?: string,
): Promise<ResolvedAttachment[]> {
  const media = message.image ?? message.document ?? message.audio ?? message.video;
  if (!media) return [];
  try {
    // Download with the receiving number's token — Meta media is scoped to the
    // app that received it, so a separate-app movements number needs its own.
    const downloaded = await getMetaWhatsappApi(businessPhoneNumberId).downloadMedia(media.id);
    const filename = media.filename ?? downloaded.filename ?? message.id;
    const document = await DocumentService.createAndUpload(Readable.from(downloaded.buffer), {
      mimeType: downloaded.mimeType,
      contentLength: downloaded.buffer.length,
      description: filename,
    });
    const exposed = await exposeFile({
      stream: Readable.from(downloaded.buffer),
      filename,
      contentType: downloaded.mimeType,
      // This door resolved the sender's team before it downloaded anything, so
      // it can say whose file this is outright rather than leave it to the
      // ambient identity it happens to be running under.
      teamId,
    });
    return [
      {
        key: exposed.url,
        url: exposed.url,
        filename,
        contentType: downloaded.mimeType,
        documentId: document.id,
      },
    ];
  } catch (err) {
    logger.error('[whatsapp-dispatch] media resolve failed', { mediaId: media.id, error: String(err) });
    return [];
  }
}

/** Dispatch one inbound Meta message dumbly. Public webhook → no auth ctx, so we
 *  resolve the team from the sender and run under a Context built for it. */
export async function dispatchWhatsappMessage(input: {
  message: MetaWhatsappMessage;
  businessNumber?: string;
  /** The Meta `phone_number_id` this message was received on — which of our
   *  numbers (primary vs movements). Rides the event so a reply is sent from
   *  the same number. Absent → the primary number. */
  businessPhoneNumberId?: string;
  profileName?: string;
}): Promise<void> {
  const { message, businessNumber, businessPhoneNumberId, profileName } = input;
  const resolved = await resolveSenderTeam(message.from);
  if (!resolved) {
    logger.info('[whatsapp-dispatch] no team for sender — dropping', { from: message.from });
    return;
  }

  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: resolved.userId, teamId: resolved.teamId }));

  await ctx.runAsync(async () => {
    // Classify FIRST: reactions/locations are their own event kinds, and an
    // unsupported kind (contacts, interactive replies, system notices) is
    // dropped here — it must never fire movements as an empty message.
    const classified = classifyMetaMessage(message, { businessNumber, businessPhoneNumberId, profileName });
    if (classified === undefined) {
      logger.info('[whatsapp-dispatch] unsupported inbound kind — dropping', {
        type: message.type,
        from: message.from,
      });
      return;
    }
    const attachments =
      classified.kind === 'message'
        ? await resolveAttachments(message, resolved.teamId, businessPhoneNumberId)
        : [];
    const payload = {
      ...classified.payload,
      ...(classified.kind === 'message' ? { attachments } : {}),
    } as WhatsappPayload;

    // Which paths the receiving number is allowed to take. The movements number
    // reaches movements only; the primary number reaches legacy only; an
    // unconfigured-movements deployment keeps the trigger-first→legacy fallback.
    const route = resolveWhatsappRoute({
      businessPhoneNumberId,
      movementsPhoneNumberId: movementsPhoneNumberId(),
    });

    // The primary number, once a movements number exists, reaches no movement.
    if (route === 'legacy-only') {
      logger.info('[whatsapp-dispatch] the primary number reaches no movement — dropping', { from: message.from });
      return;
    }

    // The module's arrivals for this one message, as it reads a Meta delivery,
    // with its media resolved to the team's stored documents.
    const arrivals = whatsappInboundArrivals({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { display_phone_number: businessNumber, phone_number_id: businessPhoneNumberId },
                contacts: profileName !== undefined ? [{ profile: { name: profileName } }] : [],
                messages: [message],
              },
            },
          ],
        },
      ],
    }).map((arrival) =>
      classified.kind === 'message' && !('gone' in arrival)
        ? { ...arrival, landing: { ...arrival.landing, fields: { ...arrival.landing.fields, ...payload } } }
        : arrival,
    );
    // Under the team's doors: an upgrade's move of a listen waits for it. A
    // carried version's listens judge the arrivals this door built with their
    // own judge; a failure throws, and Meta's retry keeps one receipt per
    // listen, named by the wamid.
    const teamId = teamIdSchema.parse(resolved.teamId);
    const { kept, fires, carriedFired } = await withDoorsHeld(teamId, async () => {
      const delivered = await deliverArrivals({
        teamId,
        delivered: { adapterType: WHATSAPP_ADAPTER_TYPE, credentialsId: null },
        subscriptionId: WHATSAPP_KIND,
        // The wamid is the DELIVERY id: Meta redelivers anything that was not
        // acked with a 2xx, and a redelivery under it keeps nothing twice.
        externalId: `whatsapp:${message.id}`,
        source: 'webhook',
        arrivals,
        // Its media are already the team's documents: a replay judges these
        // arrivals again rather than reading Meta's delivery afresh.
        request: keptPage({ adapterType: WHATSAPP_ADAPTER_TYPE, credentialsId: null, arrivals }),
      });
      const carried = await judgeCarriedPage({
        teamId,
        adapterType: WHATSAPP_ADAPTER_TYPE,
        providerKey: WHATSAPP_KIND,
        credentialsId: null,
        page: arrivals,
        stableKey: `whatsapp:${message.id}`,
        ...(delivered.kept.kept ? { deliveryId: delivered.deliveryId } : {}),
      });
      return { ...delivered, carriedFired: carried };
    });
    if (!kept.kept && carriedFired === 0) return;
    notifyWork();
    const ran = fires.length + carriedFired;
    // Read receipt at preprocess: a message a movement will handle shows blue
    // ticks immediately (ruling 2026-07-07). Fire-and-forget — a receipt
    // failure must never affect dispatch. Messages only; Meta has no receipt
    // for reactions/locations.
    if (classified.kind === 'message' && ran > 0) {
      void getMetaWhatsappApi(businessPhoneNumberId).markMessageRead(message.id).catch(() => {});
    }
    if (ran === 0) {
      logger.info('[whatsapp-dispatch] no listen took the message — dropping', { teamId: resolved.teamId, from: message.from });
    }
  });
}
