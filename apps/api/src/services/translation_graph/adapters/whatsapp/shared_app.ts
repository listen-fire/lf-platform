// The platform's one WhatsApp app: the Meta app and numbers the deployment
// configures (`WHATSAPP_*`), which send for every team, and the Twilio account
// whose media are the platform's. WhatsApp takes no team credential, so this
// is the credential the `@lf/whatsapp` line hands its module; a deployment
// that configures nothing hands empty fields, and a send then fails at call
// time exactly as before modules.

import type { CredentialFields } from 'module-kit';

import { whatsappManifest } from '@listen-fire/whatsapp/manifest';

/** The shared WhatsApp number people message to trigger movements — a stable
 *  public contact point, surfaced in the manifest so the authoring agent can
 *  tell users exactly which number to message. Which number that is belongs to
 *  the deployment, so it comes from env; an install that has not registered a
 *  WhatsApp sender leaves it unset and nothing quotes a number. */
export const WHATSAPP_MOVEMENTS_NUMBER = process.env.WHATSAPP_MOVEMENTS_NUMBER?.trim() || null;

/** Click-to-chat link that opens a WhatsApp conversation with the shared
 *  number. Hand it to the user once their number is linked so getting started
 *  is a single tap rather than saving a contact by hand. `wa.me` wants digits
 *  only (no `+`, no spaces). */
export const WHATSAPP_MOVEMENTS_WA_ME_LINK = WHATSAPP_MOVEMENTS_NUMBER
  ? `https://wa.me/${WHATSAPP_MOVEMENTS_NUMBER.replace(/\D/g, '')}`
  : null;

/** The platform's manifest: the module's, quoting the shared number. */
export const WHATSAPP_MANIFEST = whatsappManifest(WHATSAPP_MOVEMENTS_NUMBER);

/** The shared app's credential, read from env per call. */
export function sharedWhatsappCredential(): CredentialFields {
  const env = process.env;
  const movements = env.WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID;
  const graph = env.WHATSAPP_GRAPH_BASE_URL;
  const twilio = env.TWILIO_ACCOUNT_SID;
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    ...(movements !== undefined ? { movementsPhoneNumberId: movements } : {}),
    ...(graph !== undefined && graph !== '' ? { baseUrl: graph } : {}),
    ...(twilio !== undefined && twilio !== '' ? { twilioAccountSid: twilio } : {}),
  };
}
