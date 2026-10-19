// WhatsApp's own check of a request at its inbound door: Meta's verification
// handshake, signed deliveries, and inbound media read by Meta's id.

import { createHmac } from 'node:crypto';

import type { CredentialFields, ModuleCredential } from 'module-kit';
import type { FileRef, InboundCheckInput } from 'movement-engine/public/adapter';

import { adapterInProcess, refusingFiles, refusingKv } from 'module-kit';

import { whatsappModule, whatsappModuleWith } from '../index';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const OWN = { accessToken: 'TOKEN', phoneNumberId: 'PN-1', webhookVerifyToken: 'verify-me' };
const APP_SECRET = 'meta-app-secret';

function load(fields: CredentialFields = OWN, definition = whatsappModule) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    if (String(url) === 'https://graph.facebook.com/v19.0/MEDIA-1') return new Response(JSON.stringify({ url: 'https://lookaside.example/MEDIA-1' }));
    return new Response('image-bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const credential: ModuleCredential = { name: 'whatsapp', fields: async () => fields, update: async () => {} };
  const loaded = adapterInProcess(definition, {
    tenant: 'team-1',
    credential,
    fetch,
    log: silent,
    files: refusingFiles('no files'),
    kv: refusingKv('no kv'),
    validateResults: true,
  });
  return { adapter: loaded.adapter, calls };
}

function request(input: { method?: string; query?: string; body?: string; headers?: Record<string, string>; secret?: string }): InboundCheckInput {
  return {
    request: {
      method: input.method ?? 'POST',
      path: '/api/public/webhook-sync/whatsapp/wa',
      query: input.query ?? '',
      headers: input.headers ?? {},
      body: Buffer.from(input.body ?? '', 'utf-8').toString('base64'),
    },
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
  };
}

const DELIVERY = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { display_phone_number: '+447700900000' },
            contacts: [{ profile: { name: 'Ada' } }],
            messages: [
              { from: '447700900001', id: 'wamid.1', type: 'text', text: { body: 'hello' } },
              { from: '447700900001', id: 'wamid.2', type: 'image', image: { id: 'MEDIA-1', mime_type: 'image/jpeg', caption: 'a pic' } },
            ],
          },
        },
      ],
    },
  ],
});

const signed = (body: string, secret = APP_SECRET) => ({ 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` });

describe('@lf/whatsapp checks its own inbound', () => {
  it("answers Meta's verification handshake with the challenge, as text", async () => {
    const { adapter } = load();
    const query = 'hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444';
    expect(await adapter.checkInbound!(request({ method: 'GET', query }))).toEqual({ outcome: 'reply', status: 200, text: '1158201444' });
  });

  it('refuses a handshake with the wrong token, or when no token is set', async () => {
    const { adapter } = load();
    const wrong = 'hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1';
    expect(await adapter.checkInbound!(request({ method: 'GET', query: wrong }))).toEqual({ outcome: 'refused', status: 403 });
    const unset = load({ accessToken: 'TOKEN', phoneNumberId: 'PN-1' }).adapter;
    const right = 'hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1';
    expect(await unset.checkInbound!(request({ method: 'GET', query: right }))).toEqual({ outcome: 'refused', status: 403 });
  });

  it('accepts a delivery signed with the app secret, one event per message', async () => {
    const { adapter } = load();
    const answer = await adapter.checkInbound!(request({ body: DELIVERY, headers: signed(DELIVERY), secret: APP_SECRET }));
    expect(answer.outcome).toBe('accepted');
    if (answer.outcome !== 'accepted') return;
    expect(answer.events.map((e) => [e.externalId, e.tag])).toEqual([
      ['wamid.1', 'message'],
      ['wamid.2', 'message'],
    ]);
    expect(answer.events[1]?.payload).toMatchObject({ body: 'a pic', attachments: [{ key: 'meta-media:MEDIA-1', contentType: 'image/jpeg' }] });
  });

  it('refuses a delivery with a bad or missing signature, or with no secret to check it with', async () => {
    const { adapter } = load();
    expect(await adapter.checkInbound!(request({ body: DELIVERY, headers: signed(DELIVERY, 'other'), secret: APP_SECRET }))).toEqual({ outcome: 'refused', status: 401 });
    expect(await adapter.checkInbound!(request({ body: DELIVERY, secret: APP_SECRET }))).toEqual({ outcome: 'refused', status: 401 });
    expect(await adapter.checkInbound!(request({ body: DELIVERY, headers: signed(DELIVERY) }))).toEqual({ outcome: 'refused', status: 401 });
  });

  it("reads an inbound media item by Meta's id with the install's own token", async () => {
    const { adapter, calls } = load();
    const ref = { __brand: 'FileRef', name: 'wamid.2', source: { kind: 'owned', adapterType: 'whatsapp', handle: 'meta-media:MEDIA-1' } } as FileRef;
    const resolved = await adapter.resolveFileRef!({ ref });
    expect(resolved.contentType).toBe('image/jpeg');
    expect(calls).toEqual([
      { url: 'https://graph.facebook.com/v19.0/MEDIA-1', authorization: 'Bearer TOKEN' },
      { url: 'https://lookaside.example/MEDIA-1', authorization: 'Bearer TOKEN' },
    ]);
  });

  it('a host on a shared Meta app (the platform) neither hands nor reads media by id', async () => {
    const { adapter, calls } = load(OWN, whatsappModuleWith({}));
    const answer = await adapter.checkInbound!(request({ body: DELIVERY, headers: signed(DELIVERY), secret: APP_SECRET }));
    if (answer.outcome !== 'accepted') throw new Error('expected accepted');
    expect(answer.events[1]?.payload).toMatchObject({ attachments: [{ key: 'MEDIA-1' }] });
    const ref = { __brand: 'FileRef', name: 'x', source: { kind: 'owned', adapterType: 'whatsapp', handle: 'meta-media:MEDIA-1' } } as FileRef;
    await expect(adapter.resolveFileRef!({ ref })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
