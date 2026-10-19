// WhatsApp's legacy line: the module's adapter (@lf/whatsapp) over the path
// the platform used before modules — the Meta clients built from env at
// import (services/whatsapp/metaApi.ts), its exposed-file URLs, and a file's
// bytes read as any byte consumer here reads them. Kept so the
// `BUILTIN_MODULES` line for WhatsApp can go back to `legacy` in one edit
// while the module line is new; remove it with the line once the module line
// has soaked.

import type { FileValue } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { WhatsappAdapter as WhatsappModuleAdapter, issuedTwilioMedia, type WhatsappSources } from '@listen-fire/whatsapp';
import { logger } from 'movement-engine/public/log';
import { getMetaWhatsappApi } from '../../../whatsapp/metaApi';
import { isExposedFileUrl } from '../../engine/files/expose';
import { streamFileRef } from '../../engine/files/retrieve';

export {
  WHATSAPP_ADAPTER_TYPE,
  WHATSAPP_ATTACHMENTS_FIELD,
  WHATSAPP_ATTACHMENT_TYPE_ID,
  WHATSAPP_INBOUND_LOCATION_TYPE,
  WHATSAPP_INBOUND_REACTION_TYPE,
  WHATSAPP_RECORD_TYPE_ID,
  WHATSAPP_TYPING_TYPE,
  type WhatsappAttachment,
  type WhatsappPayload,
} from '@listen-fire/whatsapp';
export { WHATSAPP_MANIFEST, WHATSAPP_MOVEMENTS_NUMBER, WHATSAPP_MOVEMENTS_WA_ME_LINK } from './shared_app';

async function bytesOf(file: FileValue, teamId: TeamId): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of (await streamFileRef(file, { teamId })).stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function legacySources(teamId: TeamId): WhatsappSources {
  return {
    sender: async (phoneNumberId) => getMetaWhatsappApi(phoneNumberId),
    issued: async (handle) => (isExposedFileUrl(handle) ? true : issuedTwilioMedia(handle, process.env.TWILIO_ACCOUNT_SID)),
    // Global fetch, looked up per call (so a test's stub is seen).
    fetch: (input, init) => fetch(input, init),
    readFile: (file) => bytesOf(file, teamId),
    log: logger,
  };
}

export class WhatsappAdapter extends WhatsappModuleAdapter {
  constructor(readonly teamId: TeamId) {
    super(legacySources(teamId));
  }
}

/** Factory matching the registry's AdapterFactory signature. */
export function createWhatsappAdapter(input: { teamId: TeamId }): WhatsappAdapter {
  return new WhatsappAdapter(input.teamId);
}
