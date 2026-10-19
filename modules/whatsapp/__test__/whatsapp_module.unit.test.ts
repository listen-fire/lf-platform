// The module over a host context: which number a credential sends from and
// where it reaches Meta, which media handles are the install's, and how a
// file a write hands it is read. The whole surface's answers are held to the
// legacy adapter by apps/api's recorded parity (whatsapp_parity.unit.test.ts).

import type { CredentialFields, ModuleCredential, ModuleFiles } from 'module-kit';

import { adapterInProcess, noCredential, refusingFiles, refusingKv } from 'module-kit';
import { fileValue, ownedFileSource } from 'movement-engine/public/adapter';

import { whatsappModule, whatsappModuleWith, type WhatsappHost } from '../index';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function credential(fields: CredentialFields): ModuleCredential {
  return { name: 'whatsapp', fields: async () => fields, update: async () => {} };
}

const OWN = { accessToken: 'TOKEN', phoneNumberId: 'PN-1', movementsPhoneNumberId: 'PN-2', twilioAccountSid: 'AC1' };

function load(input: { credential: ModuleCredential; host?: WhatsappHost; baseUrlOverride?: string; files?: ModuleFiles }) {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null });
    if (String(url).endsWith('/media')) return new Response(JSON.stringify({ id: 'MEDIA-UP' }), { status: 200 });
    if (String(url).startsWith('https://files.example/')) return new Response('bytes', { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 });
  };
  const definition = input.host === undefined ? whatsappModule : whatsappModuleWith(input.host);
  const loaded = adapterInProcess(definition, {
    tenant: 'team-1',
    credential: input.credential,
    fetch,
    log: silent,
    files: input.files ?? refusingFiles('no files'),
    kv: refusingKv('no kv'),
    ...(input.baseUrlOverride !== undefined ? { baseUrlOverride: input.baseUrlOverride } : {}),
    validateResults: true,
  });
  return { adapter: loaded.adapter, manifest: loaded.manifest, calls };
}

const mutationContext = { source: {}, occurredAt: '2026-10-19T00:00:00.000Z' };
const reply = (data: Record<string, unknown>, fields: Record<string, unknown> = { Body: 'hi' }) =>
  ({ mutationContext, recordType: 'Message', fields, parentLinks: [{ recordType: 'Message', externalId: 'wamid.IN', edgeName: 'Replies', data }] }) as never;

describe('@lf/whatsapp', () => {
  it('declares its credential and no signed inbound; the manifest quotes the number its host names', () => {
    const own = load({ credential: credential(OWN) });
    expect(own.manifest.credentials?.[0]?.name).toBe('whatsapp');
    expect(own.manifest.inbound).toBeUndefined();
    expect(whatsappModule.manifest.description).toMatch(/^WhatsApp on the shared Listen-Fire number\. /);
    expect(whatsappModuleWith({ movementsNumber: '+44 7700 900000' }).manifest.description).toContain('(+44 7700 900000)');
  });

  it('replies from the number its message arrived on, at Meta, with the credential’s token', async () => {
    const { adapter, calls } = load({ credential: credential(OWN) });
    await adapter.createRecord(reply({ from: '447700900001', businessPhoneNumberId: 'PN-2' }));
    await adapter.createRecord(reply({ from: '447700900001', businessPhoneNumberId: 'PN-9' }));
    await adapter.createRecord(reply({ from: '447700900001' }));
    expect(calls.map((call) => call.url)).toEqual([
      'https://graph.facebook.com/v19.0/PN-2/messages',
      'https://graph.facebook.com/v19.0/PN-1/messages',
      'https://graph.facebook.com/v19.0/PN-1/messages',
    ]);
    expect(calls.every((call) => call.authorization === 'Bearer TOKEN')).toBe(true);
    expect(calls[0]?.body).toMatchObject({ to: '+447700900001', text: { body: 'hi' }, context: { message_id: 'wamid.IN' } });
  });

  it('reaches the dev loop’s fake over the credential’s base URL, and the base URL over the credential’s', async () => {
    const own = load({ credential: credential({ ...OWN, baseUrl: 'http://own.example/graph' }) });
    await own.adapter.createRecord(reply({ from: '1' }));
    const faked = load({ credential: credential({ ...OWN, baseUrl: 'http://own.example/graph' }), baseUrlOverride: 'http://fake.example/graph' });
    await faked.adapter.createRecord(reply({ from: '1' }));
    expect([own.calls[0]?.url, faked.calls[0]?.url]).toEqual(['http://own.example/graph/PN-1/messages', 'http://fake.example/graph/PN-1/messages']);
  });

  it('refuses a send by name when the install has no credential', async () => {
    const { adapter } = load({ credential: noCredential('WhatsApp: no credential is connected') });
    await expect(adapter.createRecord(reply({ from: '1' }))).rejects.toThrow('no credential is connected');
  });

  it('owns the media its host exposed and its Twilio account’s, and fetches only those', async () => {
    const host: WhatsappHost = { exposedFileUrl: (url) => url.startsWith('https://files.example/') };
    const { adapter, calls } = load({ credential: credential(OWN), host });
    const ref = (handle: string) => ({ ref: { __brand: 'FileRef' as const, name: 'x', source: ownedFileSource({ adapterType: 'whatsapp', handle }) } });
    const exposed = await adapter.resolveFileRef!(ref('https://files.example/blob/1'));
    expect('stream' in exposed && exposed.contentType).toBe('text/plain');
    await expect(adapter.resolveFileRef!(ref('https://api.twilio.com/2010-04-01/Accounts/AC2/Media/M'))).rejects.toThrow('not one its owner whatsapp issued');
    const lf = load({ credential: credential({ accessToken: 'T', phoneNumberId: 'P' }) });
    await expect(lf.adapter.resolveFileRef!(ref('https://files.example/blob/1'))).rejects.toThrow('TWILIO_ACCOUNT_SID is not configured');
    expect(calls.map((call) => call.url)).toEqual(['https://files.example/blob/1']);
  });

  it('sends a file a write hands it, read through the host’s files, uploaded then sent by id', async () => {
    const read: unknown[] = [];
    const files: ModuleFiles = {
      ...refusingFiles('no put'),
      read: async (file) => {
        read.push(file.name);
        return new TextEncoder().encode('%PDF');
      },
    };
    const { adapter, calls } = load({ credential: credential(OWN), files });
    const file = fileValue({ __brand: 'FileRef', name: 'deck.pdf', contentType: 'application/pdf', source: ownedFileSource({ adapterType: 'gmail', handle: 'h' }) });
    const result = await adapter.createRecord(reply({ from: '447700900001' }, { Body: 'the deck', File: file }));
    expect(read).toEqual(['deck.pdf']);
    expect(calls.map((call) => call.url)).toEqual(['https://graph.facebook.com/v19.0/PN-1/media', 'https://graph.facebook.com/v19.0/PN-1/messages']);
    expect(calls[1]?.body).toMatchObject({ type: 'document', document: { id: 'MEDIA-UP', caption: 'the deck', filename: 'deck.pdf' } });
    expect(result.externalId).toBe('wamid.OUT');
  });
});
