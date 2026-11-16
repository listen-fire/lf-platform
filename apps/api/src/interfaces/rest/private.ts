import { RequestHandler, Request, Response } from 'express';
import { currentPrincipal } from 'principal';


import { currentContext } from '../../services/context';
import { catchingRoutes } from './async_route';
import { logger } from 'movement-engine/public/log';
import { sendSlackNotification } from '../../lib/slack';
import { getQb } from '../../lib/kysely';
import { TeamId } from '../../generated/kysely/core/Team';
import type { Arrival } from 'engine-contracts';
import { deliverArrivals } from '../../services/inbound/listen_door';
import { judgeCarriedPage, withDoorsHeld } from '../../services/inbound/carried_delivery';
import { keptPage } from '../../services/inbound/captured_request';
import { notifyWork } from '../../services/work/drain';
import {
  normaliseInboundEmailPayload,
  EMAIL_ADAPTER_TYPE,
} from '../../services/translation_graph/adapters/email';
import { fetchResendEmailPayload } from '../../services/translation_graph/adapters/email/resend_inbound';
import { readMailgunMessage, readResendEnvelope, resendEnvelopeRecipients, withoutMailgunSigning } from '@listen-fire/email';
import { emailActingUser, inboundEmailArrival } from '../../services/translation_graph/adapters/email/arrival';
import { findPublicInbox } from '../../services/translation_graph/adapters/email/public_inbox';

/**
 * The team this message belongs to — the one the DOOR already decided from the
 * sender (D31/D32) and handed to the funnel as the requested team, read back off
 * the Principal rather than through `Context.user`. `user` is user-SHAPED and
 * throws when there is no user, and a coreless deployment authenticates as a
 * machine principal with none (D2) — so the whole inbound-email door, which only
 * ever wanted a tenant, answered nothing at all rather than accepting the mail.
 */
function actingTeamId(): TeamId {
  return currentPrincipal().teamId as TeamId;
}

/**
 * What an inbound email is, once its provider's wire shape has been read off.
 *
 * Everything below this line is the same for every provider: who is allowed to
 * send, which trigger answers, and what happens when none does. The parsing
 * above it is not — Mailgun posts the whole message as a form, Resend posts an
 * id and has to be asked — and that difference is the ONLY thing the two
 * handlers keep to themselves.
 */
interface InboundEmail {
  /** The adapter's advertised `EmailPayload` fields, over whatever else the
   *  provider sent. */
  payload: Record<string, unknown>;
  /** Who the message was addressed to — for the quarantine record. */
  recipients: string[];
}

const acceptInboundEmail = async (
  req: Request,
  res: Response,
  email: InboundEmail,
): Promise<Response> => {
  const ctx = currentContext();
  const teamId = actingTeamId();

  // T5 — sender-auth gate. Run BEFORE plus-key routing because plus-key
  // is a routing signal, not an auth signal (anyone can email a
  // `<local>+<key>@` address). The platform parses sender /
  // forwarding-recipient candidates (`emailActorCandidates`) off the email's
  // arrival, as every run of it reads them; `resolveActingUser` maps them
  // through the sender → service-account chain. Null means "no Listen-Fire team member is authenticated for this
  // dispatch" and the request is rejected. No trigger context here (this
  // gate runs pre-routing), so neither creator-override nor creator-
  // fallback applies — same behaviour as the prior inline chain.
  //
  // Auth-passed-but-no-matching-trigger is quarantined below rather than
  // processed: the legacy pipeline this used to fall through to is gone.
  //
  // A PUBLIC INBOX skips the gate: the team claimed that key to take mail from
  // anyone, so finding no sender of the team is the expected case, not a
  // rejection. The door already settled who the run acts as (a member who
  // sent it, else whoever claimed the key).
  //
  // The contract seam: every email TriggerEvent built from here on
  // carries the adapter's advertised EmailPayload fields (bodyText,
  // bodyHtml, messageId, typed attachments) merged over the raw body.
  //
  // The door already decided all of this during authentication — which team
  // this email belongs to and which of that team's triggers, if any, its
  // `<local>+<key>@` address names. Asking again here would be a second,
  // possibly different, answer to the same question.
  const route = req.inboundEmailRoute;
  const emailPayload = email.payload;
  const inbox = route?.key ? await findPublicInbox(route.key) : null;
  const arrival = inboundEmailArrival({ payload: emailPayload, fallbackIdentity: ctx.id });
  if (inbox?.teamId !== teamId) {
    const actingUser = await emailActingUser({ teamId, arrival });
    if (!actingUser) {
      logger.warn('[InboundEmail] rejected unauthenticated email', {
        teamId,
      });
      return res.status(401).send();
    }
  }

  const intendedRecipients = email.recipients;

  // The email is an arrival on the team's `Emails`, keyed by the plus-suffix
  // it was sent to, judged by every email listen of the team
  // (inbound/listen_door.ts). Store-then-ack: the delivery and the run each
  // listen starts are durable before we answer, and the sender never waits on
  // a movement run. The Message-Id is the DELIVERY id: both providers
  // redeliver on anything that isn't a 2xx, and a redelivery under it keeps
  // nothing twice.
  const messageId =
    typeof emailPayload['messageId'] === 'string' && emailPayload['messageId'].length > 0 ? emailPayload['messageId'] : undefined;
  let fired: number;
  try {
    const arrivals: Arrival[] = [arrival];
    // Under the team's doors: an upgrade's move of a listen waits for it. A
    // carried version's listens judge the arrival this door built with their
    // own judge; a failure answers 500, and the redelivery keeps one receipt
    // per listen, named by the Message-Id.
    const { kept, fires, carriedFired } = await withDoorsHeld(teamId, async () => {
      const delivered = await deliverArrivals({
        teamId,
        delivered: { adapterType: EMAIL_ADAPTER_TYPE, credentialsId: null },
        subscriptionId: EMAIL_ADAPTER_TYPE,
        externalId: messageId !== undefined ? `email:${messageId}` : null,
        source: 'webhook',
        arrivals,
        // The provider's message is read by this door, not a module: a replay
        // judges the arrival it read again.
        request: keptPage({ adapterType: EMAIL_ADAPTER_TYPE, credentialsId: null, arrivals }),
      });
      const stableKey = messageId !== undefined ? `email:${messageId}` : `email:request:${ctx.id}`;
      const carriedFired = await judgeCarriedPage({
        teamId,
        adapterType: EMAIL_ADAPTER_TYPE,
        credentialsId: null,
        page: arrivals,
        stableKey,
        ...(delivered.kept.kept ? { deliveryId: delivered.deliveryId } : {}),
      });
      return { ...delivered, carriedFired };
    });
    if (!kept.kept && carriedFired === 0) return res.status(201).send();
    fired = fires.length + carriedFired;
  } catch (err) {
    logger.error('[InboundEmail] failed to keep the delivery', {
      teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).send();
  }
  if (fired > 0) {
    notifyWork();
    return res.status(201).send();
  }

  // Authenticated, but no listen of this team took it. The
  // pipeline this used to fall through to is retired, so quarantine rather
  // than drop: persist the raw payload BEFORE acking, so a team that should
  // have been onboarded isn't silently losing mail and the row can be replayed
  // once a movement listens for it (scripts/replay_dropped_emails.ts).
  await getQb(['dropped_inbound_email'])
    .insertInto('dropped_inbound_email')
    .values({
      team_id: teamId,
      request_id: ctx.id,
      reason: 'no_matching_trigger',
      recipients: intendedRecipients,
      body: emailPayload as unknown,
    })
    .execute();

  logger.warn('[InboundEmail] no movement listens for this address — stored for replay', {
    teamId,
    intendedRecipients,
  });
  await sendSlackNotification({
    type: 'SUPPORT',
    text: `Dropped an inbound email for team ${teamId} (recipients: ${intendedRecipients.join(', ')}) — no automation listens for that address. Stored for replay.`,
    opsTitle: `Dropped an inbound email with no matching automation (recipients: ${intendedRecipients.join(', ')})`,
  });
  return res.status(200).send();
};

/**
 * Mailgun posts the whole message as a form, so reading it is a normalisation
 * and nothing more. Its signing fields were read by the door's verification
 * and go no further: not into the email's record, a run, a kept delivery or
 * a quarantined body.
 */
const receiveInboundEmail: RequestHandler = async (req, res) =>
  acceptInboundEmail(req, res, {
    payload: normaliseInboundEmailPayload(withoutMailgunSigning((req.body ?? {}) as Record<string, unknown>)),
    recipients: readMailgunMessage(req.body)?.recipients ?? [],
  });

/**
 * Resend posts an id. The body, the headers and the attachment list all have
 * to be fetched before there is an email at all — which is why a Resend API
 * outage surfaces here as a 500 (a retryable answer for a retryable failure)
 * rather than as an email with no content.
 */
const receiveResendInboundEmail: RequestHandler = async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '';
  const envelope = readResendEnvelope(raw);
  // The door already answered anything that is not mail arriving; reaching
  // here without an envelope means the body changed under us.
  if (envelope === null) return res.status(406).send();

  return acceptInboundEmail(req, res, {
    payload: await fetchResendEmailPayload(envelope.email_id),
    recipients: resendEnvelopeRecipients(envelope),
  });
};

/**
 * A rejection escaping these handlers used to leave the provider's socket
 * unanswered — express 4 drops an async handler's rejection on the floor, and
 * only the event-store write above sits in a try/catch, so a failing quarantine
 * insert or Slack notice hung the request instead of failing it. 500 is the same
 * answer the store failure already gives: not taken, retry (`async_route.ts`).
 */
const catchingInboundEmail = catchingRoutes((res, err) => {
  logger.error('[InboundEmail] unhandled failure', {
    error: err instanceof Error ? err.message : String(err),
  });
  return res.status(500).send();
});

const inboundEmailHandler: RequestHandler = catchingInboundEmail(receiveInboundEmail);
const resendInboundEmailHandler: RequestHandler = catchingInboundEmail(receiveResendInboundEmail);

export { inboundEmailHandler, resendInboundEmailHandler };
