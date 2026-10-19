// WhatsApp's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// WhatsApp without loading the adapter.
//
// The number people message belongs to the deployment, so the host names it:
// the platform quotes its shared number; a host with none (lf, where the
// number is the user's own) quotes no number.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { WHATSAPP_HANDBOOK_SECTION } from './handbook_section';
import { WHATSAPP_ADAPTER_TYPE } from './types';

/**
 * Source and target: a listen receives each message (text and media),
 * reaction and location; a write replies, reacts or shows typing along a
 * message's edges. No `requiredCredentialType`: on the platform WhatsApp takes
 * no team credential (its one Meta app sends for every team). No meta root.
 */
export function whatsappManifest(movementsNumber: string | null): AdapterManifest {
  return {
    adapterType: WHATSAPP_ADAPTER_TYPE,
    displayName: 'WhatsApp',
    website: 'https://www.whatsapp.com',
    category: 'Messaging',
    description:
      `WhatsApp on the shared Listen-Fire number${
        movementsNumber ? ` (${movementsNumber})` : ''
      }. ` +
      'Message it and a movement runs on each message — text and media ' +
      'included (voice notes transcribe). Movements can reply (threaded), ' +
      'react with an emoji, and show the typing indicator. Built in; no account ' +
      "to connect — but the sender's phone must be linked to their Listen-Fire " +
      'account first, or their messages are ignored.',
    supportedTriggers: ['webhook'],
    // `listen to wa { events: [...] }` — no `events` subscribes to messages
    // only, so reactions/locations never fire a movement that didn't opt in.
    subscribableEvents: ['message', 'reaction', 'location'],
    // A config-less listen receives MESSAGES ONLY (the dispatch gate,
    // `triggerAcceptsWhatsappKind`) — declared so the checker types it the
    // same way the runtime delivers it.
    defaultSubscribedEvents: ['message'],
    methods: [
      'listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'preprocessInbound',
      'getActorCandidates', 'extractActor', 'resolveFileRef', 'createRecord', 'listEventTypes',
    ],
    triggerKinds: ['INBOUND_WHATSAPP', 'TWILIO'],
    triggerExpectation:
      `Fires when a WhatsApp message arrives at the shared Listen-Fire number` +
      `${movementsNumber ? ` (${movementsNumber})` : ''} — ` +
      `each message (text and media; voice ` +
      `notes transcribe) is one event. The number is common to every Listen-Fire user: ` +
      `routing works by identifying the sender from their linked phone, so ONLY ` +
      `messages the user sends from their own linked number reach their ` +
      `movements. A message from anyone else — a founder, an LP, any unlinked ` +
      `number — is unrecognized and dropped, and it never reads anyone's ` +
      `WhatsApp chats or groups. So it is a channel the user messages ` +
      `deliberately: always frame it first-person ("when I forward or send … to ` +
      `the Listen-Fire number"), never as someone else messaging the number.`,
    handbookSection: WHATSAPP_HANDBOOK_SECTION,
    vocabulary: {
      icon: {
        d: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
        fill: true,
      },
      eventPhrase: {
        // No per-event phrasing today (`message` / `reaction` / `location`
        // all shared the same generic sentence in the former switch) —
        // `default` mirrors that, channel→tag→bare.
        default: [
          { template: 'When a WhatsApp message arrives in {channel}' },
          { template: 'When a WhatsApp message arrives in `{key}`' },
          { template: 'When a WhatsApp message arrives' },
        ],
      },
    },
  };
}

/** The manifest with no number quoted. */
export const WHATSAPP_MANIFEST: AdapterManifest = whatsappManifest(null);
