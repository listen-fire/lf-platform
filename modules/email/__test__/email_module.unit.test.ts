// The module over a host context: which keys reach which provider, where the
// dev loop's fake takes Resend, and the sender a user's own credential makes.
// The whole surface's answers are held to the legacy adapter by apps/api's
// recorded parity (email_parity.unit.test.ts).

import type { CredentialFields, ModuleCredential } from 'module-kit';
import type { FileRef } from 'movement-engine/public/adapter';

import { adapterInProcess, noCredential, refusingFiles, refusingKv } from 'module-kit';

import { emailModule, emailSenderFrom, emailCredentialFields } from '../index';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function credential(fields: CredentialFields): ModuleCredential {
  return { name: 'email', fields: async () => fields, update: async () => {} };
}

function load(input: { credential: ModuleCredential; baseUrlOverride?: string }) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization') });
    if (String(url).includes('/attachments?')) {
      return new Response(JSON.stringify({ data: [{ id: 'a1', filename: 'f.txt', download_url: 'https://dl.example/f' }], has_more: false }));
    }
    return new Response('bytes', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const loaded = adapterInProcess(emailModule, {
    tenant: 'team-1',
    credential: input.credential,
    fetch,
    log: silent,
    files: refusingFiles('no files'),
    kv: refusingKv('no kv'),
    ...(input.baseUrlOverride !== undefined ? { baseUrlOverride: input.baseUrlOverride } : {}),
    validateResults: true,
  });
  return { adapter: loaded.adapter, manifest: loaded.manifest, calls };
}

const owned = (handle: string): { ref: FileRef } => ({
  ref: { __brand: 'FileRef', name: 'f', source: { kind: 'owned', adapterType: 'email', handle } } as FileRef,
});

describe('@lf/email', () => {
  it('declares the email credential and that it checks its own inbound', () => {
    const { manifest } = load({ credential: credential({}) });
    expect(manifest.adapterType).toBe('email');
    expect(manifest.credentials?.[0]?.name).toBe('email');
    expect(manifest.inbound).toEqual({ providerKey: 'email', scheme: 'module' });
    expect(manifest.methods).toContain('checkInbound');
  });

  it('mints a Resend attachment’s URL with the credential’s key, at the dev loop’s fake when there is one', async () => {
    const { adapter, calls } = load({ credential: credential({ resendApiKey: 're_1', resendBaseUrl: 'https://resend.example' }), baseUrlOverride: 'http://fake' });
    await adapter.resolveFileRef?.(owned('resend:e1/a1'));
    expect(calls[0]).toEqual({ url: 'http://fake/emails/receiving/e1/attachments?limit=100', authorization: 'Bearer re_1' });
    expect(calls[1]?.url).toBe('https://dl.example/f');
  });

  it('sends the Mailgun key only to a storage URL of the credential’s domain', async () => {
    const { adapter, calls } = load({ credential: credential({ mailgunApiKey: 'k', mailgunSendingDomain: 'example.com' }) });
    await adapter.resolveFileRef?.(owned('https://storage.mailgun.net/v3/domains/example.com/messages/m/attachments/0'));
    expect(calls[0]?.authorization).toBe(`Basic ${Buffer.from('api:k').toString('base64')}`);
    await expect(adapter.resolveFileRef?.(owned('https://storage.mailgun.net/v3/domains/other.com/messages/m/attachments/0'))).rejects.toThrow(
      /configured Mailgun domain/,
    );
    expect(calls).toHaveLength(1);
  });

  it('refuses by name, when the bytes are wanted, a provider whose key the host did not hand over', async () => {
    const { adapter, calls } = load({ credential: noCredential('none') });
    await expect(adapter.resolveFileRef?.(owned('resend:e1/a1'))).rejects.toThrow(/no Resend API key/);
    expect(calls).toEqual([]);
  });

  it('makes a sender of a user’s own credential: Resend first, then Mailgun, else one that refuses', () => {
    const fields = (raw: Record<string, string>) => emailCredentialFields.parse(raw);
    expect(emailSenderFrom(fields({ from: 'a@b.c', resendApiKey: 'r', mailgunApiKey: 'm', mailgunSendingDomain: 'd' })).provider).toBe('resend');
    expect(emailSenderFrom(fields({ from: 'a@b.c', mailgunApiKey: 'm', mailgunSendingDomain: 'd' })).provider).toBe('mailgun');
    expect(emailSenderFrom(fields({ from: 'a@b.c', mailgunApiKey: 'm' })).provider).toBe('unconfigured');
    expect(emailSenderFrom(fields({ resendApiKey: 'r', from: ' ' })).provider).toBe('unconfigured');
  });

  it('sends through Resend with the credential’s key and the host’s fetch', async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"id":"1"}');
    };
    const { sender } = emailSenderFrom(emailCredentialFields.parse({ from: 'me@b.c', fromName: 'Me', resendApiKey: 'r', resendBaseUrl: 'http://resend' }), { fetch });
    await expect(sender.send({ recipients: [{ email: 'you@b.c', username: '' }], subject: 'Hi', data: 'x' })).resolves.toBe(true);
    expect(posted[0]).toMatchObject({ url: 'http://resend/emails', body: { from: 'Me <me@b.c>', to: ['you@b.c'], subject: 'Hi', text: 'x' } });
  });
});
