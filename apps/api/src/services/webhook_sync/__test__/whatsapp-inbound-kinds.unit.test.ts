// Inbound WhatsApp classification — every Meta message kind either becomes a
// TYPED event or is dropped; nothing falls through as an empty message (the
// spurious-firing bug: a 👍 reaction used to parse as a blank message and run
// every whatsapp movement).

import {
  WHATSAPP_INBOUND_LOCATION_TYPE,
  WHATSAPP_INBOUND_REACTION_TYPE,
  WHATSAPP_RECORD_TYPE_ID,
  classifyMetaMessage,
  triggerAcceptsWhatsappKind,
  whatsappInboundEvents,
} from '@listen-fire/whatsapp';

const base = { from: '15551234567', id: 'wamid.IN', timestamp: '1700000000' };

describe('classifyMetaMessage', () => {
  it('text → message kind with the flattened payload', () => {
    const out = classifyMetaMessage({ ...base, type: 'text', text: { body: 'hi' } });
    expect(out).toMatchObject({ kind: 'message', rootRecordType: WHATSAPP_RECORD_TYPE_ID });
    expect(out?.payload).toMatchObject({ body: 'hi', messageId: 'wamid.IN' });
  });

  it('reaction → its own event type carrying emoji + the reacted message', () => {
    const out = classifyMetaMessage({
      ...base,
      type: 'reaction',
      reaction: { message_id: 'wamid.TARGET', emoji: '👍' },
    });
    expect(out).toMatchObject({ kind: 'reaction', rootRecordType: WHATSAPP_INBOUND_REACTION_TYPE });
    expect(out?.payload).toMatchObject({ emoji: '👍', reactedMessageId: 'wamid.TARGET' });
  });

  it('location → its own event type with coordinates', () => {
    const out = classifyMetaMessage({
      ...base,
      type: 'location',
      location: { latitude: 51.5, longitude: -0.12, name: 'Office' },
    });
    expect(out).toMatchObject({ kind: 'location', rootRecordType: WHATSAPP_INBOUND_LOCATION_TYPE });
    expect(out?.payload).toMatchObject({ latitude: 51.5, longitude: -0.12, name: 'Office' });
  });

  it('sticker → a message with the sticker as its media attachment', () => {
    const out = classifyMetaMessage({
      ...base,
      type: 'sticker',
      sticker: { id: 'media-9', mime_type: 'image/webp' },
    });
    expect(out?.kind).toBe('message');
    expect(out?.payload).toMatchObject({
      attachments: [{ key: 'media-9', contentType: 'image/webp' }],
    });
  });

  it('unsupported kinds (contacts, system) → undefined, never an empty message', () => {
    expect(classifyMetaMessage({ ...base, type: 'contacts' })).toBeUndefined();
    expect(classifyMetaMessage({ ...base, type: 'unsupported' })).toBeUndefined();
  });

  it('carries the receiving number id (businessPhoneNumberId) on every kind — the reply-from selector', () => {
    const ctx = { businessPhoneNumberId: 'PN_MOVE' };
    expect(
      classifyMetaMessage({ ...base, type: 'text', text: { body: 'hi' } }, ctx)?.payload,
    ).toMatchObject({ businessPhoneNumberId: 'PN_MOVE' });
    expect(
      classifyMetaMessage({ ...base, type: 'reaction', reaction: { message_id: 'm', emoji: '👍' } }, ctx)
        ?.payload,
    ).toMatchObject({ businessPhoneNumberId: 'PN_MOVE' });
    // Absent when not provided (primary path / Twilio) — no key, so send falls
    // back to the primary number.
    expect(
      classifyMetaMessage({ ...base, type: 'text', text: { body: 'hi' } })?.payload,
    ).not.toHaveProperty('businessPhoneNumberId');
  });
});

describe('triggerAcceptsWhatsappKind — the listen `events` gate', () => {
  it('no events config subscribes to messages ONLY', () => {
    expect(triggerAcceptsWhatsappKind(undefined, 'message')).toBe(true);
    expect(triggerAcceptsWhatsappKind({}, 'reaction')).toBe(false);
    expect(triggerAcceptsWhatsappKind(null, 'location')).toBe(false);
  });

  it('an explicit events list is honoured verbatim', () => {
    expect(triggerAcceptsWhatsappKind({ events: ['reaction'] }, 'reaction')).toBe(true);
    expect(triggerAcceptsWhatsappKind({ events: ['reaction'] }, 'message')).toBe(false);
    expect(triggerAcceptsWhatsappKind({ events: ['message', 'location'] }, 'location')).toBe(true);
  });
});

describe('whatsappInboundEvents (BYO door) — typed, drop-not-blank', () => {
  const envelope = (message: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '15550000000' },
              contacts: [{ wa_id: '15551234567', profile: { name: 'Ada' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });

  it('a reaction parses to a reaction-typed event', () => {
    const events = whatsappInboundEvents(
      envelope({ ...base, type: 'reaction', reaction: { message_id: 'wamid.T', emoji: '🔥' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'reaction',
      tag: 'reaction',
      recordType: WHATSAPP_INBOUND_REACTION_TYPE,
      externalId: 'wamid.IN',
    });
  });

  it('an unsupported kind yields NO event', () => {
    expect(whatsappInboundEvents(envelope({ ...base, type: 'contacts' }))).toEqual([]);
  });
});
