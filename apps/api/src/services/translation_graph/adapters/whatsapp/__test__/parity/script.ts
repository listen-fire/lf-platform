// The calls recorded parity makes, in order, against one WhatsApp
// implementation: the whole adapter surface (schema, inbound, fields on the
// Meta door's and Twilio's payload shapes, walks, actor, file bytes, and every
// write with its refusals). The transcript is every answer as JSON, with the
// provider's base URL (which differs per run) written as `<base>`; two
// implementations agree when their transcripts and the requests they made are
// identical.

import type { Adapter, FileRef } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';

import { fileValue } from 'movement-engine/public/adapter';
import { makeMetaPosition, makeStablePosition, makeUnstablePosition } from 'movement-engine/public/catalog';
import { withFileOwners } from 'movement-engine/public/files';

export interface WhatsappParitySubject {
  adapter: Adapter;
  /** Where the provider is: Meta's Graph API under `/whatsapp/graph`, and the
   *  platform's exposed files under `/api/files/blob`. */
  baseUrl: string;
  /** False where the host exposes no files of its own and redeems no file it
   *  was handed in process (a module served as a process): the steps that read
   *  an exposed file's bytes or send one are skipped. */
  hostFiles: boolean;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

/** The deployment's own Twilio account, as the recording configures it. */
export const PARITY_TWILIO_ACCOUNT = 'ACparity';
export const PRIMARY_NUMBER_ID = 'PN-PRIMARY';
export const MOVEMENTS_NUMBER_ID = 'PN-MOVEMENTS';

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** One Meta delivery: a text, an image with a caption, a sticker, a reaction,
 *  a location, then kinds no listen takes (a contact card, a button tap). */
const META_ENVELOPE = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA-1',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { display_phone_number: '+44 7700 900000', phone_number_id: MOVEMENTS_NUMBER_ID },
            contacts: [{ wa_id: '447700900001', profile: { name: 'Ada' } }],
            messages: [
              { from: '447700900001', id: 'wamid.T1', timestamp: '1700000000', type: 'text', text: { body: 'Closed the round!' } },
              { from: '447700900001', id: 'wamid.I1', timestamp: '1700000001', type: 'image', image: { id: 'MEDIA-1', mime_type: 'image/jpeg', caption: 'the deck' } },
              { from: '447700900001', id: 'wamid.S1', timestamp: '1700000002', type: 'sticker', sticker: { id: 'MEDIA-2', mime_type: 'image/webp' } },
              { from: '447700900001', id: 'wamid.R1', timestamp: '1700000003', type: 'reaction', reaction: { message_id: 'wamid.T1', emoji: '👍' } },
              { from: '447700900001', id: 'wamid.L1', timestamp: '1700000004', type: 'location', location: { latitude: 51.5, longitude: -0.12, name: 'Office', address: '1 Road' } },
              { from: '447700900001', id: 'wamid.C1', timestamp: '1700000005', type: 'contacts', contacts: [{ name: { formatted_name: 'Bo' } }] },
              { from: '447700900001', id: 'wamid.B1', timestamp: '1700000006', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'cb_1', title: 'Yes' } } },
            ],
          },
        },
        { field: 'statuses', value: { statuses: [{ id: 'wamid.X', status: 'read' }] } },
      ],
    },
  ],
};

/** A message as the Meta door seeds it: its media downloaded and exposed at
 *  the platform's blob route, the receiving number's id on it. */
function dispatchedMessage(baseUrl: string, businessPhoneNumberId: string): Record<string, unknown> {
  const blob = `${baseUrl}/api/files/blob/deck-1`;
  return {
    messageId: 'wamid.IN1',
    from: '447700900001',
    to: '447700900000',
    businessPhoneNumberId,
    body: 'Here is the deck',
    waId: '447700900001',
    profileName: 'Ada',
    timestamp: '1700000000',
    attachments: [{ key: blob, url: blob, filename: 'deck.pdf', contentType: 'application/pdf' }],
  };
}

/** A raw Twilio webhook, as the retired Twilio door delivered it. */
const TWILIO_RAW = {
  MessageSid: 'SM1',
  From: 'whatsapp:+447700900002',
  To: 'whatsapp:+447700900000',
  Body: 'raw twilio',
  WaId: '447700900002',
  ProfileName: ' Bo ',
  NumMedia: '3',
  MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${PARITY_TWILIO_ACCOUNT}/Messages/MM1/Media/ME1`,
  MediaContentType0: 'image/jpeg',
  MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/ACother/Messages/MM1/Media/ME2',
  MediaContentType1: 'application/x-not-a-type',
  MediaUrl2: 'http://api.twilio.com/2010-04-01/Accounts/ACparity/Messages/MM1/Media/ME3',
  MediaContentType2: 'audio/ogg',
};

export async function runWhatsappParityScript(subject: WhatsappParitySubject): Promise<TranscriptEntry[]> {
  const { adapter, baseUrl } = subject;
  const transcript: TranscriptEntry[] = [];
  const json = (value: unknown): unknown =>
    value === undefined ? null : JSON.parse(JSON.stringify(value).split(baseUrl).join('<base>'));
  const step = async <T>(name: string, call: () => Promise<T>): Promise<T | undefined> => {
    try {
      const answer = await call();
      transcript.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: json({ error: error instanceof Error ? error.message : String(error) }) });
      return undefined;
    }
  };

  // ── Schema ──
  await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const type of ['Message', 'Attachment', 'Reaction', 'Location', 'Typing', 'whatsapp:message', 'whatsapp:reaction', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  const meta = makeMetaPosition('whatsapp');
  await step('edgesFrom meta', async () => (await adapter.edgesFrom?.(meta)) ?? null);
  await step('listEventTypes', async () => (await adapter.listEventTypes?.()) ?? null);
  await step('runtimeCapabilities', async () => adapter.runtimeCapabilities?.() ?? null);

  // ── Inbound ──
  for (const [name, raw] of [
    ['meta envelope', META_ENVELOPE],
    ['empty envelope', { object: 'whatsapp_business_account', entry: [] }],
    ['malformed', { entry: [{ changes: [{ value: { messages: [{ text: { body: 'no ids' } }] } }] }] }],
    ['not an object', 'hello'],
  ] as const) {
    await step(`preprocessInbound ${name}`, async () => (await adapter.preprocessInbound?.({ raw })) ?? null);
  }
  const inbound = await adapter.preprocessInbound?.({ raw: META_ENVELOPE });
  const payloadOf = (index: number) => (inbound?.events[index]?.payload ?? {}) as Record<string, unknown>;

  // ── Fields ──
  const dispatched = dispatchedMessage(baseUrl, MOVEMENTS_NUMBER_ID);
  const message = makeStablePosition({ adapterType: 'whatsapp', recordType: 'Message', recordId: 'wamid.IN1', data: dispatched });
  const typeless = makeStablePosition({ adapterType: 'whatsapp', recordType: null as never, recordId: 'SM1', data: TWILIO_RAW });
  const twilio = makeStablePosition({ adapterType: 'whatsapp', recordType: 'Message', recordId: 'SM1', data: TWILIO_RAW });
  const messageFields = ['Message Id', 'From', 'To', 'Body', 'File', 'Interactive', 'WhatsApp Id', 'Profile Name', 'Timestamp', 'Nope'];
  for (const [name, position] of [['dispatched', message], ['twilio', twilio], ['typeless twilio', typeless]] as const) {
    for (const field of messageFields) {
      await step(`${name}.${field}`, () => adapter.getFieldValue({ position, fieldId: field }));
    }
  }
  const reaction = makeStablePosition({ adapterType: 'whatsapp', recordType: 'Reaction', recordId: 'wamid.R1', data: payloadOf(3) });
  for (const field of ['Emoji', 'Reacted Message Id', 'Message Id', 'From', 'Profile Name', 'Timestamp']) {
    await step(`Reaction.${field}`, () => adapter.getFieldValue({ position: reaction, fieldId: field }));
  }
  const location = makeStablePosition({ adapterType: 'whatsapp', recordType: 'Location', recordId: 'wamid.L1', data: payloadOf(4) });
  for (const field of ['Latitude', 'Longitude', 'Name', 'Address', 'From']) {
    await step(`Location.${field}`, () => adapter.getFieldValue({ position: location, fieldId: field }));
  }
  await step('foreign position', () => adapter.getFieldValue({ position: makeMetaPosition('slack'), fieldId: 'Body' }));

  // ── Attachments ──
  let exposedFile: FileRef | undefined;
  const files: FileRef[] = [];
  for (const [name, position] of [['dispatched', message], ['twilio', twilio]] as const) {
    const attachments = await step(`${name} Attachments`, () => adapter.getRelated({ position, fieldId: 'Attachments', direction: 'outgoing' }));
    for (const [index, attachment] of (attachments ?? []).entries()) {
      for (const field of ['Name', 'Content Type', 'URL', 'File']) {
        const value = await step(`${name} Attachment ${index}.${field}`, () => adapter.getFieldValue({ position: attachment.position, fieldId: field }));
        if (field === 'File' && value !== null && typeof value === 'object') {
          files.push(value as FileRef);
          if (name === 'dispatched' && index === 0) exposedFile = value as FileRef;
        }
      }
    }
  }
  await step('Attachments incoming', () => adapter.getRelated({ position: message, fieldId: 'Attachments', direction: 'incoming' }));
  await step('Replies is not read', () => adapter.getRelated({ position: message, fieldId: 'Replies', direction: 'outgoing' }));
  const bare = makeUnstablePosition({ adapterType: 'whatsapp', recordType: 'Attachment', data: { filename: 'x' } });
  await step('Attachment without a key .File', () => adapter.getFieldValue({ position: bare, fieldId: 'File' }));

  // ── Actor ──
  const event = (payload: unknown) => ({ payload }) as never;
  for (const [name, payload] of [['dispatched', dispatched], ['twilio', TWILIO_RAW], ['reaction', payloadOf(3)], ['no sender', {}], ['blank sender', { from: 'whatsapp:  ' }]] as const) {
    await step(`getActorCandidates ${name}`, async () => (await adapter.getActorCandidates?.({ event: event(payload) })) ?? null);
    await step(`extractActor ${name}`, async () => (await adapter.extractActor?.({ event: event(payload) })) ?? null);
  }

  // ── File bytes ──
  if (subject.hostFiles && exposedFile !== undefined) {
    const ref = exposedFile;
    await step('resolveFileRef exposed', async () => {
      const resolved = await adapter.resolveFileRef?.({ ref });
      if (resolved === undefined) return null;
      if (!('stream' in resolved)) return resolved;
      return { contentType: resolved.contentType ?? null, text: await text(resolved.stream as NodeJS.ReadableStream) };
    });
  }
  // The deployment's own Twilio media is never fetched here (it is Twilio's,
  // over https); another account's and a plain-http handle are refused.
  for (const [index, ref] of files.entries()) {
    if (ref === exposedFile || index === 1) continue;
    await step(`resolveFileRef twilio ${index}`, async () => (await adapter.resolveFileRef?.({ ref })) ?? null);
  }
  await step('resolveFileRef not a URL', async () =>
    (await adapter.resolveFileRef?.({ ref: { __brand: 'FileRef', name: 'x', source: { adapterType: 'whatsapp', handle: 'MEDIA-1' } } as FileRef })) ?? null,
  );
  await step('resolveFileRef without a handle', async () => (await adapter.resolveFileRef?.({ ref: { __brand: 'FileRef', name: 'x' } })) ?? null);

  // ── Writes ──
  const parentOf = (data: Record<string, unknown>, edgeName: string, recordType = 'Message') => ({
    adapterType: 'whatsapp',
    recordType,
    externalId: String(data.messageId ?? 'wamid.X'),
    edgeName,
    data,
  });
  const write = (name: string, input: unknown) => step(name, () => adapter.createRecord(input as never));
  await write('typing', { recordType: 'Typing', fields: {}, parentLinks: [parentOf(dispatched, 'Typing')] });
  await write('reaction', { recordType: 'Reaction', fields: { Emoji: ' 🔥 ' }, parentLinks: [parentOf(dispatched, 'Reactions')] });
  await write('reaction without emoji', { recordType: 'Reaction', fields: { Emoji: '  ' }, parentLinks: [parentOf(dispatched, 'Reactions')] });
  await write('reply', { recordType: 'Message', fields: { Body: ' Thanks Ada ' }, parentLinks: [parentOf(dispatched, 'Replies')] });
  await write('reply from an unknown number', {
    recordType: 'Message',
    fields: { Body: 'from the primary' },
    parentLinks: [parentOf(dispatchedMessage(baseUrl, 'PN-UNKNOWN'), 'Replies')],
  });
  await write('reply to a sent message', {
    recordType: 'Message',
    fields: { Body: 'again' },
    parentLinks: [parentOf({ messageId: 'wamid.fake_1', to: 'whatsapp:+447700900001' }, 'Replies')],
  });
  await write('reply to a twilio message', { recordType: 'Message', fields: { Body: 'hi Bo' }, parentLinks: [parentOf({ ...TWILIO_RAW, messageId: 'SM1' }, 'Replies')] });
  await write('interactive', {
    recordType: 'Message',
    fields: {
      Body: 'ignored',
      Interactive: { type: 'button', body: { text: 'Ship?' }, action: { buttons: [{ type: 'reply', reply: { id: 'cb_1', title: 'Yes' } }] } },
    },
    parentLinks: [parentOf(dispatched, 'Replies')],
  });
  if (subject.hostFiles && exposedFile !== undefined) {
    const file = exposedFile;
    await step('reply with the file', () =>
      withFileOwners(
        (owner) => (owner.adapterType === 'whatsapp' ? adapter : undefined),
        () => adapter.createRecord({ recordType: 'Message', fields: { Body: 'your deck', File: fileValue(file) }, parentLinks: [parentOf(dispatched, 'Replies')] } as never),
      ),
    );
  }
  await write('reply with nothing', { recordType: 'Message', fields: { Body: '   ' }, parentLinks: [parentOf(dispatched, 'Replies')] });
  await write('no parent', { recordType: 'Message', fields: { Body: 'x' } });
  await write('parent not a message', { recordType: 'Message', fields: { Body: 'x' }, parentLinks: [parentOf(payloadOf(3), 'Replies', 'Reaction')] });
  await write('wrong edge', { recordType: 'Message', fields: { Body: 'x' }, parentLinks: [parentOf(dispatched, 'Attachments')] });
  await write('parent without a sender', { recordType: 'Message', fields: { Body: 'x' }, parentLinks: [parentOf({ messageId: 'wamid.Z' }, 'Replies')] });
  await step('updateRecord', () => adapter.updateRecord({ recordType: 'Message', externalId: '1', fields: {} } as never));
  await step('deleteRecord', () => adapter.deleteRecord({ recordType: 'Message', externalId: '1' } as never));
  return transcript;
}
