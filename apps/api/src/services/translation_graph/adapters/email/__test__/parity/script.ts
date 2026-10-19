// The calls recorded parity makes, in order, against one email
// implementation: the whole adapter surface (schema, walks, fields, actor,
// attachment bytes from each provider, refusals), and — where the host is the
// platform — what the platform calls beside the adapter: the inbound doors'
// admission (Mailgun's signature, Resend's Svix signature), the parse of each
// provider's wire shape, the Resend message fetch, the provider choice, the
// routing address, and the outbound senders. The transcript is every answer
// as JSON; two implementations agree when their transcripts and the requests
// they made are identical.

import type { Adapter, FileRef } from 'movement-engine/public/adapter';
import type { SourcePosition } from 'movement-engine/public/catalog';

import { makeMetaPosition, makeStablePosition, makeUnstablePosition } from 'movement-engine/public/catalog';

/** The decision a door hands back; the script only reads it as JSON. */
type Decision = unknown;
interface Store {
  route(message: { recipients: string[]; senderCandidates: string[] }): Promise<Decision>;
}
interface Recipient {
  email: string;
  username: string;
}
interface SendArgs {
  recipients: Recipient[];
  sender?: Recipient;
  subject: string;
  data: string | { templateName: string; params: Record<string, unknown> };
  replyToHeader?: string;
  inReplyToHeader?: string;
  attachment?: { filename: string; data: Buffer };
  cc?: Recipient[];
  metadata?: { teamId?: string; kind?: string };
}
interface Sender {
  send(args: SendArgs): Promise<boolean>;
}

/** What the platform calls beside the adapter. */
export interface EmailPlatformCalls {
  manifest: { triggerConfig?: unknown; triggerExpectation?: string; configurationGap?: string };
  normaliseInboundEmailPayload(raw: Record<string, unknown>): Record<string, unknown>;
  readMailgunMessage(body: unknown): unknown;
  readResendEnvelope(body: string): { email_id: string } | null;
  resendEnvelopeRecipients(envelope: never): string[];
  admitMailgunMail(store: Store & { mailgunSigningKey(): string | undefined }, body: unknown): Promise<Decision>;
  admitResendMail(
    store: Store & { resendWebhookSecret(): string | undefined },
    delivery: { rawBody: Buffer | null; headers: Record<string, string | string[] | undefined> },
  ): Promise<Decision>;
  judgeMailgunEvent(input: { signature: unknown; apiKey: string | null }): string;
  svixSignature(input: { secret: string; id: string; timestamp: string; body: string }): string;
  verifySvixSignature(input: { secret: string; headers: { id: string; timestamp: string; signature: string }; body: string; now?: number }): string;
  mailgunSignature(input: { apiKey: string; timestamp: string; token: string }): string;
  fetchResendEmailPayload(emailId: string): Promise<Record<string, unknown>>;
  resolveEmailProvider(env: NodeJS.ProcessEnv): { slug: string; callbackPath: string };
  emailProvidersOverlap(env: NodeJS.ProcessEnv): boolean;
  chooseOutboundEmailProvider(env: NodeJS.ProcessEnv): string;
  routingKeyFrom(recipients: string[]): string | null;
  inboundRoutingAddress(env: NodeJS.ProcessEnv): unknown;
  senders: {
    resend(options: { resendApiKey: string; defaultSender: Recipient; apiBaseUrl?: string; archiveBcc?: string }): Sender;
    mailgun(options: { mailgunApiKey: string; sendingDomain: string; defaultSender: Recipient; apiBaseUrl?: string; archiveBcc?: string }): Sender;
    fake(): Sender;
    unconfigured(): Sender;
  };
}

export interface EmailParitySubject {
  adapter: Adapter;
  /** Absent where the host is not the platform (a module served as a process). */
  platform?: EmailPlatformCalls;
  /** False where the host's fetch cannot be pointed at the fake Mailgun
   *  storage (a module served as a process: the handle is Mailgun's own URL). */
  mailgunStorage: boolean;
}

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

/** Where the fake providers live, for the platform's own calls. */
export interface EmailParityProviders {
  resend: string;
  mailgun: string;
}

export const MAILGUN_STORAGE_ORIGIN = 'https://storage.eu.mailgun.net';
export const MAILGUN_KEY = 'key-parity';
export const RESEND_KEY = 're_parity';
export const RESEND_SECRET = `whsec_${Buffer.from('parity-secret').toString('base64')}`;

/** The received email the fake Resend is seeded with. */
export const RESEND_SEED = {
  id: 'em_parity',
  from: '"Ada Okafor" <Ada@Example.com>',
  to: ['inbox+deals@example.com'],
  cc: ['cc@example.com'],
  received_for: ['inbox+deals@example.com'],
  subject: 'Deck for the round',
  html: '<!DOCTYPE html><html><body><p>See the <b>deck</b>.</p></body></html>',
  text: 'See the deck.',
  headers: { 'X-Forwarded-For': 'dealflow@acme.com', 'Delivered-To': 'inbox+deals@example.com' },
  message_id: '<em_parity@mail.example.com>',
  attachments: [
    { id: 'att_1', filename: 'deck.pdf', content_type: 'application/pdf', content: Buffer.from('%PDF deck bytes').toString('base64') },
    { id: 'att_2', filename: 'notes.txt', content_type: 'text/plain', content: Buffer.from('some notes').toString('base64') },
  ],
};

function json(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

const MAILGUN_PAYLOAD = {
  messageId: '<mg-1@mail.example.com>',
  subject: 'Intro: Acme',
  sender: '"Bo Li" <bo@acme.com>',
  recipient: 'inbox+deals@example.com',
  bodyHtml: '<p>Hello <i>there</i></p>',
  bodyText: 'Hello there',
  attachments: [
    {
      key: `${MAILGUN_STORAGE_ORIGIN}/v3/domains/example.com/messages/MSG1/attachments/0`,
      filename: 'term-sheet.pdf',
      contentType: 'application/pdf',
      size: 2048,
      url: `${MAILGUN_STORAGE_ORIGIN}/v3/domains/example.com/messages/MSG1/attachments/0`,
    },
    { key: 'resend:em_parity/att_2', filename: 'notes.txt', contentType: 'text/plain' },
    { key: '', filename: 'no-handle.bin', contentType: 'application/octet-stream' },
  ],
  'X-Forwarded-For': 'dealflow@acme.com, other@acme.com',
  'message-headers': JSON.stringify([
    ['X-BeenThere', 'list@acme.com'],
    ['Delivered-To', 'Inbox+Deals@example.com'],
    ['Received', 'by mx for <inbox+deals@example.com>'],
  ]),
};

const HTML_ONLY = { messageId: 'h1', subject: 'html', sender: 'x@y.com', recipient: 'r@y.com', bodyHtml: '<div><p>Only <b>html</b></p><br/>here</div>', attachments: [] };
const MARKUP_TEXT = {
  messageId: 'm1',
  subject: 'markup',
  sender: 'x@y.com',
  recipient: 'r@y.com',
  bodyText: '<!DOCTYPE html><html><body><table><tr><td>cell</td></tr></table></body></html>',
  bodyHtml: '<p>real html</p>',
  attachments: [],
};
const PROSE_ANGLE = { messageId: 'p1', subject: 'prose', sender: 'x@y.com', recipient: 'r@y.com', bodyText: 'a <3 b and x < y', attachments: [] };
const EMPTY = { messageId: '', attachments: [] };

function emailAt(data: Record<string, unknown>, recordType = 'Email'): SourcePosition {
  return makeUnstablePosition({ adapterType: 'email', recordType, data });
}

export async function runEmailParityScript(subject: EmailParitySubject, providers: EmailParityProviders): Promise<TranscriptEntry[]> {
  const { adapter } = subject;
  const transcript: TranscriptEntry[] = [];
  const step = async <T>(name: string, call: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      const answer = await call();
      transcript.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      transcript.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };

  // ── Schema ──
  await step('listEntryPoints', () => adapter.listEntryPoints());
  for (const type of ['Email', 'Attachment', 'email:message', 'email:attachment', 'Nonexistent']) {
    await step(`describe ${type}`, () => adapter.describe(type));
  }
  const meta = makeMetaPosition('email');
  await step('edgesFrom meta', async () => (await adapter.edgesFrom?.(meta)) ?? null);
  await step('edgesFrom Email', async () => (await adapter.edgesFrom?.(emailAt(MAILGUN_PAYLOAD))) ?? null);
  await step('edgesFrom Attachment', async () => (await adapter.edgesFrom?.(emailAt(MAILGUN_PAYLOAD.attachments[0], 'Attachment'))) ?? null);

  // ── Fields ──
  const fields = ['Message Id', 'Subject', 'From', 'To', 'HTML Body', 'Plain Body', 'Body', 'messageId', 'content', 'Nope'];
  for (const [name, payload] of [
    ['mailgun', MAILGUN_PAYLOAD],
    ['html only', HTML_ONLY],
    ['markup text', MARKUP_TEXT],
    ['prose angle', PROSE_ANGLE],
    ['empty', EMPTY],
  ] as const) {
    for (const field of fields) {
      await step(`${name}.${field}`, () => adapter.getFieldValue({ position: emailAt(payload), fieldId: field }));
    }
  }
  await step('resend-aliased position .Subject', () =>
    adapter.getFieldValue({ position: makeUnstablePosition({ adapterType: 'resend', recordType: 'Email', data: MAILGUN_PAYLOAD }), fieldId: 'Subject' }),
  );
  await step('foreign position', () => adapter.getFieldValue({ position: makeMetaPosition('slack'), fieldId: 'Subject' }));

  // ── The Attachments edge ──
  const attachments = await step('Attachments', () =>
    adapter.getRelated({ position: emailAt(MAILGUN_PAYLOAD), fieldId: 'Attachments', direction: 'outgoing' }),
  );
  await step('Attachments incoming', () => adapter.getRelated({ position: emailAt(MAILGUN_PAYLOAD), fieldId: 'Attachments', direction: 'incoming' }));
  await step('Attachments of an empty email', () => adapter.getRelated({ position: emailAt(EMPTY), fieldId: 'Attachments', direction: 'outgoing' }));
  await step('foreign getRelated', () => adapter.getRelated({ position: makeMetaPosition('slack'), fieldId: 'Attachments', direction: 'outgoing' }));
  const files: FileRef[] = [];
  for (const [index, attachment] of (attachments ?? []).entries()) {
    for (const field of ['Name', 'Content Type', 'Size', 'URL', 'File', 'filename']) {
      const value = await step(`Attachment ${index}.${field}`, () => adapter.getFieldValue({ position: attachment.position, fieldId: field }));
      if (field === 'File' && value !== null && typeof value === 'object') files.push(value as FileRef);
    }
  }

  // ── Actor ──
  // A webhook delivery's event, as the inbound handlers build it.
  const event = (payload: unknown) => ({ pipelineInputId: 'pi-parity', adapterType: 'email', triggerType: 'webhook', payload }) as never;
  await step('getActorCandidates mailgun', async () => (await adapter.getActorCandidates?.({ event: event(MAILGUN_PAYLOAD) })) ?? null);
  await step('getActorCandidates From header only', async () =>
    (await adapter.getActorCandidates?.({ event: event({ From: 'Cy <cy@acme.com>', 'message-headers': [['X-Original-To', 'orig@acme.com']] }) })) ?? null,
  );
  await step('getActorCandidates empty', async () => (await adapter.getActorCandidates?.({ event: event({}) })) ?? null);
  await step('extractActor mailgun', async () => (await adapter.extractActor?.({ event: event(MAILGUN_PAYLOAD) })) ?? null);
  await step('extractActor bare address', async () => (await adapter.extractActor?.({ event: event({ sender: 'bare@acme.com' }) })) ?? null);
  await step('extractActor none', async () => (await adapter.extractActor?.({ event: event({ sender: 'not an address' }) })) ?? null);

  // ── Attachment bytes ──
  const redeem = async (ref: FileRef) => {
    const resolved = await adapter.resolveFileRef?.({ ref });
    if (resolved === undefined) return null;
    if (!('stream' in resolved)) return resolved;
    return { contentType: resolved.contentType ?? null, text: await text(resolved.stream as NodeJS.ReadableStream) };
  };
  const handle = (value: string): FileRef => ({ __brand: 'FileRef', name: 'x', source: { kind: 'owned', adapterType: 'email', handle: value } }) as FileRef;
  if (subject.mailgunStorage && files[0] !== undefined) {
    const mailgunFile = files[0];
    await step('resolveFileRef mailgun', () => redeem(mailgunFile));
  }
  if (files[1] !== undefined) {
    const resendFile = files[1];
    await step('resolveFileRef resend', () => redeem(resendFile));
  }
  await step('resolveFileRef resend, attachment gone', () => redeem(handle('resend:em_parity/att_9')));
  await step('resolveFileRef mailgun, another domain', () => redeem(handle(`${MAILGUN_STORAGE_ORIGIN}/v3/domains/other.com/messages/X/attachments/0`)));
  await step('resolveFileRef mailgun, encoded traversal', () => redeem(handle(`${MAILGUN_STORAGE_ORIGIN}/v3/domains/example.com/..%2fother.com/x`)));
  await step('resolveFileRef look-alike host', () => redeem(handle('https://evilmailgun.net/v3/domains/example.com/messages/X')));
  await step('resolveFileRef foreign handle', () => redeem(handle('blob:somewhere-else')));
  await step('resolveFileRef without a handle', () => redeem({ __brand: 'FileRef', name: 'x' } as FileRef));

  // ── Writes ──
  const mutationContext = { source: { kind: 'parity' }, occurredAt: '2026-10-19T00:00:00.000Z' };
  await step('createRecord', () => adapter.createRecord({ mutationContext, recordType: 'Email', fields: { Subject: 'x' } } as never));

  if (subject.platform !== undefined) await platformSteps(subject.platform, providers, step);
  return transcript;
}

type Step = <T>(name: string, call: () => Promise<T> | T) => Promise<T | undefined>;

async function platformSteps(platform: EmailPlatformCalls, providers: EmailParityProviders, step: Step): Promise<void> {
  // ── The manifest's deployment-dependent surface ──
  await step('manifest triggerConfig', () => platform.manifest.triggerConfig);
  await step('manifest triggerExpectation', () => platform.manifest.triggerExpectation);
  await step('manifest configurationGap', () => platform.manifest.configurationGap ?? null);
  await step('inboundRoutingAddress', () => platform.inboundRoutingAddress({ INBOUND_EMAIL_ADDRESS: ' Mail@Example.com ' }));
  await step('inboundRoutingAddress plus', () => platform.inboundRoutingAddress({ INBOUND_EMAIL_ADDRESS: 'a+b@example.com' }));
  await step('routingKeyFrom', () => platform.routingKeyFrom(['someone@else.com', 'INBOX-dealflow+Deals@Example.com']));
  await step('routingKeyFrom none', () => platform.routingKeyFrom(['inbox@example.com']));

  // ── Provider choice ──
  for (const [name, env] of [
    ['none', {}],
    ['mailgun', { MAILGUN_API_KEY: 'k' }],
    ['resend', { RESEND_API_KEY: 'k' }],
    ['both', { RESEND_API_KEY: 'k', MAILGUN_API_KEY: 'k' }],
  ] as const) {
    await step(`resolveEmailProvider ${name}`, () => {
      const provider = platform.resolveEmailProvider(env);
      return { slug: provider.slug, callbackPath: provider.callbackPath };
    });
    await step(`emailProvidersOverlap ${name}`, () => platform.emailProvidersOverlap(env));
  }
  for (const [name, env] of [
    ['development', { NODE_ENV: 'development', RESEND_API_KEY: 'k', OUTBOUND_EMAIL_FROM: 'a@b.c' }],
    ['production, no from', { NODE_ENV: 'production', RESEND_API_KEY: 'k' }],
    ['production, resend', { NODE_ENV: 'production', RESEND_API_KEY: 'k', OUTBOUND_EMAIL_FROM: 'a@b.c' }],
    ['staging, mailgun', { NODE_ENV: 'staging', MAILGUN_API_KEY: 'k', MAILGUN_SENDING_DOMAIN: 'd', OUTBOUND_EMAIL_FROM: 'a@b.c' }],
    ['production, mailgun without domain', { NODE_ENV: 'production', MAILGUN_API_KEY: 'k', OUTBOUND_EMAIL_FROM: 'a@b.c' }],
  ] as const) {
    await step(`chooseOutboundEmailProvider ${name}`, () => platform.chooseOutboundEmailProvider(env as NodeJS.ProcessEnv));
  }

  // ── Mailgun's wire shape and door ──
  const mailgunBody = {
    sender: 'bo@acme.com',
    from: 'Bo Li <bo@acme.com>',
    recipient: 'inbox+deals@example.com',
    To: 'Inbox <inbox+deals@example.com>, Other <other@example.com>',
    Cc: 'cc@example.com',
    subject: 'Intro',
    'body-plain': 'plain body',
    'stripped-text': 'stripped',
    'body-html': '<p>html</p>',
    'Message-Id': '<mg-2@acme.com>',
    'X-Forwarded-For': 'dealflow@acme.com other@acme.com',
    'Delivered-To': 'inbox+deals@example.com',
    attachments: JSON.stringify([
      { url: `${MAILGUN_STORAGE_ORIGIN}/v3/domains/example.com/messages/M2/attachments/0`, name: 'a.pdf', 'content-type': 'application/pdf', size: 10 },
      { name: 'no-url.txt' },
      { size: 3 },
    ]),
    'message-headers': JSON.stringify([['Received', 'from x by y for &lt;bcc+deals@example.com&gt;']]),
    timestamp: '1700000000',
    token: 'tok',
  };
  const signed = { ...mailgunBody, signature: platform.mailgunSignature({ apiKey: MAILGUN_KEY, timestamp: '1700000000', token: 'tok' }) };
  await step('normaliseInboundEmailPayload mailgun', () => platform.normaliseInboundEmailPayload(mailgunBody));
  await step('normaliseInboundEmailPayload contract-shaped', () =>
    platform.normaliseInboundEmailPayload({ messageId: 'id', bodyText: 't', bodyHtml: '<p>h</p>', attachments: [{ filename: 'f', contentType: 'text/plain', url: 'https://x/y' }] }),
  );
  await step('normaliseInboundEmailPayload broken attachments', () => platform.normaliseInboundEmailPayload({ attachments: '{nope' }));
  await step('readMailgunMessage', () => platform.readMailgunMessage(signed));
  await step('readMailgunMessage no sender', () => platform.readMailgunMessage({ subject: 'x' }));
  await step('readMailgunMessage not an object', () => platform.readMailgunMessage(['x']));
  const routed: Store = {
    route: async (message) => ({ outcome: 'routed', userId: 'user-1', teamId: 'team-1', route: { teamId: 'team-1', key: null, trigger: null }, message }),
  };
  const mailgunStore = (key: string | undefined) => ({ ...routed, mailgunSigningKey: () => key });
  await step('admitMailgunMail signed', () => platform.admitMailgunMail(mailgunStore(MAILGUN_KEY), signed));
  await step('admitMailgunMail bad signature', () => platform.admitMailgunMail(mailgunStore(MAILGUN_KEY), { ...signed, signature: 'f'.repeat(64) }));
  await step('admitMailgunMail short signature', () => platform.admitMailgunMail(mailgunStore(MAILGUN_KEY), { ...signed, signature: 'abc' }));
  await step('admitMailgunMail no key', () => platform.admitMailgunMail(mailgunStore(undefined), signed));
  await step('admitMailgunMail not mail', () => platform.admitMailgunMail(mailgunStore(MAILGUN_KEY), { subject: 'x' }));
  const eventSignature = { timestamp: '1700000000', token: 'tok', signature: signed.signature };
  await step('judgeMailgunEvent verified', () => platform.judgeMailgunEvent({ signature: eventSignature, apiKey: MAILGUN_KEY }));
  await step('judgeMailgunEvent refused', () => platform.judgeMailgunEvent({ signature: { ...eventSignature, token: 'other' }, apiKey: MAILGUN_KEY }));
  await step('judgeMailgunEvent malformed', () => platform.judgeMailgunEvent({ signature: { token: 1 }, apiKey: MAILGUN_KEY }));
  await step('judgeMailgunEvent misconfigured', () => platform.judgeMailgunEvent({ signature: eventSignature, apiKey: null }));

  // ── Resend's wire shape and door ──
  const nowSeconds = String(Math.floor(Date.now() / 1000));
  const delivery = JSON.stringify({
    type: 'email.received',
    created_at: '2026-10-19T00:00:00.000Z',
    data: {
      email_id: RESEND_SEED.id,
      from: RESEND_SEED.from,
      to: RESEND_SEED.to,
      cc: ['Cc Person <CC@example.com>'],
      bcc: [],
      received_for: RESEND_SEED.received_for,
      message_id: RESEND_SEED.message_id,
      subject: RESEND_SEED.subject,
    },
  });
  const svixHeaders = (body: string, timestamp = nowSeconds) => ({
    'svix-id': 'msg_parity',
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${platform.svixSignature({ secret: RESEND_SECRET, id: 'msg_parity', timestamp, body })}`,
  });
  const envelope = platform.readResendEnvelope(delivery);
  await step('readResendEnvelope', () => envelope);
  await step('readResendEnvelope other type', () => platform.readResendEnvelope(JSON.stringify({ type: 'email.sent', data: { email_id: 'x' } })));
  await step('readResendEnvelope not json', () => platform.readResendEnvelope('{'));
  await step('resendEnvelopeRecipients', () => (envelope === null ? null : platform.resendEnvelopeRecipients(envelope as never)));
  const resendStore = (secret: string | undefined) => ({ ...routed, resendWebhookSecret: () => secret });
  await step('admitResendMail signed', () =>
    platform.admitResendMail(resendStore(RESEND_SECRET), { rawBody: Buffer.from(delivery), headers: svixHeaders(delivery) }),
  );
  await step('admitResendMail rotated secrets', () => {
    const headers = svixHeaders(delivery);
    return platform.admitResendMail(resendStore(RESEND_SECRET), {
      rawBody: Buffer.from(delivery),
      headers: { ...headers, 'svix-signature': `v1,AAAA v2,zzz ${headers['svix-signature']}` },
    });
  });
  await step('admitResendMail re-serialised body', () =>
    platform.admitResendMail(resendStore(RESEND_SECRET), { rawBody: Buffer.from(JSON.stringify(JSON.parse(delivery), null, 1)), headers: svixHeaders(delivery) }),
  );
  await step('admitResendMail stale', () =>
    platform.admitResendMail(resendStore(RESEND_SECRET), { rawBody: Buffer.from(delivery), headers: svixHeaders(delivery, String(Number(nowSeconds) - 3600)) }),
  );
  await step('admitResendMail no raw body', () => platform.admitResendMail(resendStore(RESEND_SECRET), { rawBody: null, headers: svixHeaders(delivery) }));
  await step('admitResendMail no secret', () => platform.admitResendMail(resendStore(undefined), { rawBody: Buffer.from(delivery), headers: svixHeaders(delivery) }));
  const sent = JSON.stringify({ type: 'email.sent', data: { email_id: 'x' } });
  await step('admitResendMail not mail', () => platform.admitResendMail(resendStore(RESEND_SECRET), { rawBody: Buffer.from(sent), headers: svixHeaders(sent) }));
  const noId = JSON.stringify({ type: 'email.received', data: { from: 'a@b.c' } });
  await step('admitResendMail no email id', () => platform.admitResendMail(resendStore(RESEND_SECRET), { rawBody: Buffer.from(noId), headers: svixHeaders(noId) }));
  const noSender = JSON.stringify({ type: 'email.received', data: { email_id: 'x', from: 'nobody' } });
  await step('admitResendMail no sender', () => platform.admitResendMail(resendStore(RESEND_SECRET), { rawBody: Buffer.from(noSender), headers: svixHeaders(noSender) }));
  await step('verifySvixSignature fixed clock', () =>
    platform.verifySvixSignature({
      secret: RESEND_SECRET,
      headers: { id: 'msg_1', timestamp: '1700000000', signature: `v1,${platform.svixSignature({ secret: RESEND_SECRET, id: 'msg_1', timestamp: '1700000000', body: 'b' })}` },
      body: 'b',
      now: 1_700_000_100_000,
    }),
  );
  await step('verifySvixSignature malformed', () =>
    platform.verifySvixSignature({ secret: RESEND_SECRET, headers: { id: 'm', timestamp: 'soon', signature: 'v1,x' }, body: 'b' }),
  );
  await step('fetchResendEmailPayload', () => platform.fetchResendEmailPayload(RESEND_SEED.id));
  await step('fetchResendEmailPayload unknown', () => platform.fetchResendEmailPayload('em_missing'));

  // ── Outbound senders ──
  const from = { email: 'notices@example.com', username: 'Listen-Fire' };
  const to = [{ email: 'ada@example.com', username: 'Ada' }];
  const resend = platform.senders.resend({ resendApiKey: RESEND_KEY, defaultSender: from, apiBaseUrl: providers.resend, archiveBcc: 'archive@example.com' });
  await step('resend send text', () => resend.send({ recipients: to, subject: 'Hi', data: 'plain words' }));
  await step('resend send html, cc, reply, attachment', () =>
    resend.send({
      recipients: to,
      cc: [{ email: 'cc@example.com', username: '' }],
      sender: { email: 'other@example.com', username: '' },
      subject: 'Report',
      data: '<!DOCTYPE html><p>report</p>',
      replyToHeader: 'reply@example.com',
      inReplyToHeader: '<prev@example.com>',
      attachment: { filename: 'r.csv', data: Buffer.from('a,b\n1,2') },
      metadata: { teamId: 'team-1', kind: 'report' },
    }),
  );
  await step('resend send template', () => resend.send({ recipients: to, subject: 'T', data: { templateName: 'welcome', params: {} } }));
  await step('resend without key', () => platform.senders.resend({ resendApiKey: '', defaultSender: from }));
  await step('resend without from', () => platform.senders.resend({ resendApiKey: RESEND_KEY, defaultSender: { email: '', username: '' } }));
  const mailgun = platform.senders.mailgun({ mailgunApiKey: MAILGUN_KEY, sendingDomain: 'example.com', defaultSender: from, apiBaseUrl: providers.mailgun });
  await step('mailgun send text', () => mailgun.send({ recipients: to, subject: 'Hi', data: 'plain words' }));
  await step('mailgun send html with cc and reply', () =>
    mailgun.send({ recipients: to, cc: [{ email: 'cc@example.com', username: '' }], subject: 'H', data: '<!DOCTYPE html><p>x</p>', replyToHeader: 'r@example.com', inReplyToHeader: '<p@example.com>' }),
  );
  await step('mailgun send template', () => mailgun.send({ recipients: to, subject: 'T', data: { templateName: 'welcome', params: { name: 'Ada' } } }));
  await step('mailgun without key', () => platform.senders.mailgun({ mailgunApiKey: '', sendingDomain: 'example.com', defaultSender: from }));
  await step('mailgun without domain', () => platform.senders.mailgun({ mailgunApiKey: MAILGUN_KEY, sendingDomain: '', defaultSender: from }));
  await step('mailgun without from', () => platform.senders.mailgun({ mailgunApiKey: MAILGUN_KEY, sendingDomain: 'example.com', defaultSender: { email: '', username: '' } }));
  await step('fake send', () =>
    platform.senders.fake().send({ recipients: to, subject: 'Fake', data: 'x', attachment: { filename: 'f.txt', data: Buffer.from('abc') } }),
  );
  await step('unconfigured send', () => platform.senders.unconfigured().send({ recipients: to, subject: 'Nope', data: 'x', metadata: { kind: 'k' } }));
}
