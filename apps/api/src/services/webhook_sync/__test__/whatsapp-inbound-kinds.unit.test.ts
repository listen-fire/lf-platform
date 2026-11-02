// Inbound WhatsApp classification — every Meta message kind either arrives on
// the edge of its own kind or is dropped; nothing falls through as an empty message (the
// spurious-firing bug: a 👍 reaction used to parse as a blank message and run
// every whatsapp movement).

import { classifyMetaMessage, whatsappInboundArrivals } from '@listen-fire/whatsapp';

const base = { from: '15551234567', id: 'wamid.IN', timestamp: '1700000000' };

describe('classifyMetaMessage', () => {
  it('text → message kind with the flattened payload', () => {
    const out = classifyMetaMessage({ ...base, type: 'text', text: { body: 'hi' } });
    expect(out?.kind).toBe('message');
    expect(out?.payload).toMatchObject({ body: 'hi', messageId: 'wamid.IN' });
  });

  it('reaction → its own event type carrying emoji + the reacted message', () => {
    const out = classifyMetaMessage({
      ...base,
      type: 'reaction',
      reaction: { message_id: 'wamid.TARGET', emoji: '👍' },
    });
    expect(out?.kind).toBe('reaction');
    expect(out?.payload).toMatchObject({ emoji: '👍', reactedMessageId: 'wamid.TARGET' });
  });

  it('location → its own event type with coordinates', () => {
    const out = classifyMetaMessage({
      ...base,
      type: 'location',
      location: { latitude: 51.5, longitude: -0.12, name: 'Office' },
    });
    expect(out?.kind).toBe('location');
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

describe('whatsappInboundArrivals (BYO door) — each kind on its own edge, drop-not-blank', () => {
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

  it('a message arrives on Messages, named by its WhatsApp id so a resend runs a listen once', () => {
    const arrivals = whatsappInboundArrivals(envelope({ ...base, type: 'text', text: { body: 'hi' } }));
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      edge: 'Messages',
      identity: 'wamid.IN',
      landing: { recordType: 'Message', fields: { From: '15551234567' } },
    });
  });

  it('a reaction arrives on Reactions, about the message it is on', () => {
    const arrivals = whatsappInboundArrivals(
      envelope({ ...base, type: 'reaction', reaction: { message_id: 'wamid.T', emoji: '🔥' } }),
    );
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      edge: 'Reactions',
      identity: 'wamid.IN',
      landing: { recordType: 'Reaction', fields: { Emoji: '🔥' } },
      about: { recordType: 'Message', externalId: 'wamid.T' },
    });
  });

  it('an unsupported kind is no arrival', () => {
    expect(whatsappInboundArrivals(envelope({ ...base, type: 'contacts' }))).toEqual([]);
  });
});
