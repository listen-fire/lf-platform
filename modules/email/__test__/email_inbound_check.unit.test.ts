// Email's own check of a request at its inbound door: a Mailgun form post or
// a Resend (Svix) notification, signed with the subscription's secret.

import { createHmac } from 'node:crypto';

import type { CredentialFields, ModuleCredential } from 'module-kit';
import type { InboundCheckInput } from 'movement-engine/public/adapter';

import { adapterInProcess, refusingFiles, refusingKv } from 'module-kit';

import { emailModule } from '../index';
import { svixSignature } from '../inbound/svix';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function load(fields: CredentialFields = {}) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/attachments')) return new Response(JSON.stringify({ data: [], has_more: false }));
    return new Response(JSON.stringify({ id: 'em_1', from: 'Ada <ada@example.com>', to: ['in+k@lf.test'], subject: 'Hello', text: 'Hi', message_id: '<m-1@example.com>' }));
  };
  const credential: ModuleCredential = { name: 'email', fields: async () => fields, update: async () => {} };
  const loaded = adapterInProcess(emailModule, {
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

function request(input: { body: string; headers?: Record<string, string>; secret?: string; method?: string }): InboundCheckInput {
  return {
    request: {
      method: input.method ?? 'POST',
      path: '/api/public/webhook-sync/email/mail',
      query: '',
      headers: input.headers ?? {},
      body: Buffer.from(input.body, 'utf-8').toString('base64'),
    },
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
  };
}

const MAILGUN_KEY = 'mailgun-signing-key';

function mailgunForm(key = MAILGUN_KEY): string {
  const timestamp = '1760000000';
  const token = 'tok-1';
  const signature = createHmac('sha256', key).update(timestamp + token).digest('hex');
  return new URLSearchParams({
    sender: 'ada@example.com',
    recipient: 'in+k@lf.test',
    To: 'in+k@lf.test',
    subject: 'Hello',
    'body-plain': 'Hi there',
    'Message-Id': '<m-1@example.com>',
    timestamp,
    token,
    signature,
  }).toString();
}

const RESEND_SECRET = `whsec_${Buffer.from('resend-secret').toString('base64')}`;

function resendDelivery(body: string, secret = RESEND_SECRET): Record<string, string> {
  const id = 'msg_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${svixSignature({ secret, id, timestamp, body })}` };
}

describe('@lf/email checks its own inbound', () => {
  it('accepts a Mailgun post signed with the key, as one email', async () => {
    const { adapter } = load();
    const answer = await adapter.checkInbound!(request({ body: mailgunForm(), secret: MAILGUN_KEY }));
    expect(answer.outcome).toBe('accepted');
    if (answer.outcome !== 'accepted') return;
    expect(answer.events).toHaveLength(1);
    expect(answer.events[0]).toMatchObject({
      externalId: '<m-1@example.com>',
      idempotencyKey: '<m-1@example.com>',
      recordType: 'email:message',
      tag: 'email.received',
      payload: { bodyText: 'Hi there', subject: 'Hello', sender: 'ada@example.com' },
    });
  });

  it('refuses a Mailgun post signed with another key (406, never retried)', async () => {
    const { adapter } = load();
    expect(await adapter.checkInbound!(request({ body: mailgunForm('wrong'), secret: MAILGUN_KEY }))).toEqual({ outcome: 'refused', status: 406 });
  });

  it('refuses a Mailgun post with no signature, and any post when no key is set', async () => {
    const { adapter } = load();
    const unsigned = new URLSearchParams({ sender: 'ada@example.com', subject: 'x' }).toString();
    expect(await adapter.checkInbound!(request({ body: unsigned, secret: MAILGUN_KEY }))).toEqual({ outcome: 'refused', status: 406 });
    expect(await adapter.checkInbound!(request({ body: mailgunForm() }))).toEqual({ outcome: 'refused', status: 401 });
  });

  it('accepts a Resend notification signed with the secret, fetching the message', async () => {
    const { adapter, calls } = load({ resendApiKey: 're_1' });
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', from: 'ada@example.com', to: ['in+k@lf.test'] } });
    const answer = await adapter.checkInbound!(request({ body, headers: resendDelivery(body), secret: RESEND_SECRET }));
    expect(answer.outcome).toBe('accepted');
    if (answer.outcome !== 'accepted') return;
    expect(answer.events[0]).toMatchObject({ externalId: '<m-1@example.com>', payload: { subject: 'Hello', bodyText: 'Hi' } });
    expect(calls[0]).toBe('https://api.resend.com/emails/receiving/em_1');
  });

  it('refuses a Resend notification with a bad or missing signature', async () => {
    const { adapter, calls } = load({ resendApiKey: 're_1' });
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', from: 'ada@example.com' } });
    const forged = resendDelivery(body, `whsec_${Buffer.from('other').toString('base64')}`);
    expect(await adapter.checkInbound!(request({ body, headers: forged, secret: RESEND_SECRET }))).toEqual({ outcome: 'refused', status: 406 });
    expect(await adapter.checkInbound!(request({ body, headers: { 'svix-id': 'msg_1' }, secret: RESEND_SECRET }))).toEqual({ outcome: 'refused', status: 406 });
    expect(await adapter.checkInbound!(request({ body, headers: resendDelivery(body) }))).toEqual({ outcome: 'refused', status: 401 });
    expect(calls).toEqual([]);
  });

  it('acknowledges a Resend event that is not mail arriving, running nothing', async () => {
    const { adapter } = load({ resendApiKey: 're_1' });
    const body = JSON.stringify({ type: 'email.delivered', data: {} });
    expect(await adapter.checkInbound!(request({ body, headers: resendDelivery(body), secret: RESEND_SECRET }))).toEqual({ outcome: 'accepted', events: [] });
  });

  it('takes no GET', async () => {
    const { adapter } = load();
    expect(await adapter.checkInbound!(request({ body: '', method: 'GET', secret: MAILGUN_KEY }))).toEqual({ outcome: 'refused', status: 405 });
  });
});
