// Recorded parity for email. The fixture is the legacy adapter and the
// platform's email code as they were before email became a module, driven
// through `parity/script.ts`: every answer, and every request made with what
// came back. Resend (the received message, its attachment listing and bytes,
// the send) and the dev loop's outbox are fake-channels; Mailgun (a stored
// attachment's bytes, the send) is a deterministic fake of this test's own.
// Two installs are recorded:
//   - platform: the adapter plus everything the platform calls beside it
//               (the doors' admission and parse, the Resend fetch, the
//               provider choice, the senders);
//   - process:  the adapter alone, without a Mailgun storage download, which
//               is what a module served as a process can be held to (its
//               fetch cannot be pointed at a fake Mailgun storage host).
// Each implementation is replayed against the recording and must make the
// same requests and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// EMAIL_PARITY_RECORD=1 pnpm test:unit --testPathPattern email_parity

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Exchange, ExchangeServer } from '../../__test__/parity/exchange';
import type { EmailParityProviders, EmailParitySubject, EmailPlatformCalls, TranscriptEntry } from './parity/script';

// The door's routing reads the platform's database; nothing here routes.
jest.mock('../inbound_door', () => ({ routeInboundEmail: jest.fn() }));

import { MAILGUN_KEY, MAILGUN_STORAGE_ORIGIN, RESEND_KEY, RESEND_SEED, runEmailParityScript } from './parity/script';
import { bootMailgunFake } from './parity/mailgun_fake';
import { recordingServer, replayingServer, requestOf, type ExchangeOptions } from '../../__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import { EMAIL_MANIFEST, EmailAdapter, normaliseInboundEmailPayload } from '../index';
import { fetchResendEmailPayload } from '../resend_inbound';
import { emailProvidersOverlap, resolveEmailProvider } from '../provider';
import { inboundRoutingAddress, routingKeyFrom } from '../address';
import { chooseOutboundEmailProvider } from '../../../../../adapters/email/choose';
import { OutboundResendAdapter } from '../../../../../adapters/email/resend.adapter';
import { OutboundMailgunAdapter } from '../../../../../adapters/email/mailgun.adapter';
import { UnconfiguredOutboundEmailAdapter } from '../../../../../adapters/email/unconfigured.adapter';
import {
  admitMailgunMail,
  admitResendMail,
  judgeMailgunEvent,
  readMailgunMessage,
  readResendEnvelope,
  resendEnvelopeRecipients,
  svixSignature,
  verifySvixSignature,
} from 'movement-engine/public/inbound';

const FIXTURE = join(__dirname, '__fixtures__/email_parity.json');
/** Senders post form-encoded and multipart bodies: the content type is part
 *  of what was asked. */
const EXCHANGE: ExchangeOptions = { headers: ['content-type'] };
/** Resend's attachment listing names its own address (the download URL). */
const RESEND_EXCHANGE: ExchangeOptions = { ...EXCHANGE, selfReferences: true };
/** Mailgun's sends are multipart: the boundary is random per request. */
const MAILGUN_EXCHANGE: ExchangeOptions = {
  ...EXCHANGE,
  normalize: (request) =>
    request.headers?.['content-type'] === undefined
      ? request
      : { ...request, headers: { ...request.headers, 'content-type': request.headers['content-type'].replace(/boundary=.*$/, 'boundary=<random>') } },
};
const TEAM = 'team-parity' as TeamId;

type InstallName = 'platform' | 'process';
const INSTALLS: readonly InstallName[] = ['platform', 'process'];
type Upstream = 'resend' | 'outbox' | 'mailgun';
const UPSTREAMS: readonly Upstream[] = ['resend', 'outbox', 'mailgun'];
type Recording = Record<InstallName, { transcript: TranscriptEntry[]; exchanges: Record<Upstream, Exchange[]> }>;

/** The provider servers one run talks to. */
type Servers = Record<Upstream, ExchangeServer>;

const ENV_KEYS = [
  'INBOUND_EMAIL_ADDRESS',
  'MAILGUN_API_KEY',
  'MAILGUN_SENDING_DOMAIN',
  'RESEND_API_KEY',
  'RESEND_API_BASE_URL',
  'FAKE_CHANNELS_URL',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

/** The deployment's email settings, with the providers where `servers` are. */
function configure(servers: Servers): void {
  process.env.INBOUND_EMAIL_ADDRESS = 'inbox@example.com';
  process.env.MAILGUN_API_KEY = MAILGUN_KEY;
  process.env.MAILGUN_SENDING_DOMAIN = 'example.com';
  process.env.RESEND_API_KEY = RESEND_KEY;
  process.env.RESEND_API_BASE_URL = servers.resend.baseUrl;
  process.env.FAKE_CHANNELS_URL = servers.outbox.baseUrl;
}

/** Mailgun's storage URLs are its own https host: sent to the fake instead. */
function mailgunStorageAt(mailgun: string, inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith(MAILGUN_STORAGE_ORIGIN) ? inner(mailgun + url.slice(MAILGUN_STORAGE_ORIGIN.length), init) : inner(input, init);
  };
}

function mailgunSignature(input: { apiKey: string; timestamp: string; token: string }): string {
  return createHmac('sha256', input.apiKey).update(input.timestamp + input.token).digest('hex');
}

/** The platform's email calls as they were before the module. */
function legacyPlatform(): EmailPlatformCalls {
  return {
    manifest: EMAIL_MANIFEST,
    normaliseInboundEmailPayload,
    readMailgunMessage,
    readResendEnvelope,
    resendEnvelopeRecipients,
    admitMailgunMail,
    admitResendMail: (store, delivery) => admitResendMail(store, delivery),
    judgeMailgunEvent,
    svixSignature,
    verifySvixSignature,
    mailgunSignature,
    fetchResendEmailPayload,
    resolveEmailProvider,
    emailProvidersOverlap,
    chooseOutboundEmailProvider,
    routingKeyFrom: (recipients) => routingKeyFrom(recipients),
    inboundRoutingAddress,
    senders: {
      resend: (options) => new OutboundResendAdapter(options),
      mailgun: (options) => new OutboundMailgunAdapter(options),
      // Reads FAKE_CHANNELS_URL when it is loaded.
      fake: () => {
        let sender: ReturnType<EmailPlatformCalls['senders']['fake']> | undefined;
        jest.isolateModules(() => {
          const { FakeOutboundEmailAdapter } = require('../../../../../adapters/email/fake.adapter');
          sender = new FakeOutboundEmailAdapter();
        });
        if (sender === undefined) throw new Error('the fake sender did not load');
        return sender;
      },
      unconfigured: () => new UnconfiguredOutboundEmailAdapter(),
    },
  };
}

function legacySubject(name: InstallName): EmailParitySubject {
  return {
    adapter: new EmailAdapter(TEAM),
    mailgunStorage: name === 'platform',
    ...(name === 'platform' ? { platform: legacyPlatform() } : {}),
  };
}

const providersOf = (servers: Servers): EmailParityProviders => ({ resend: servers.resend.baseUrl, mailgun: servers.mailgun.baseUrl });

jest.setTimeout(120_000);

const recording = process.env.EMAIL_PARITY_RECORD === '1';
const nodeFetch = globalThis.fetch;
beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});
afterAll(() => {
  globalThis.fetch = nodeFetch;
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

(recording ? it : it.skip)('records the legacy email code against the fakes', async () => {
  const resend = await bootFakeChannels({ file: 'resend', factory: 'resendRoutes', mount: '/resend' });
  const outbox = await bootFakeChannels({ file: 'email', factory: 'emailRoutes', mount: '/email' });
  const mailgun = await bootMailgunFake(MAILGUN_KEY);
  const fixture: Partial<Recording> = {};
  try {
    const seeded = await nodeFetch(`${resend.baseUrl}/_seed/received`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(RESEND_SEED),
    });
    expect(seeded.ok).toBe(true);
    for (const name of INSTALLS) {
      const servers: Servers = {
        resend: await recordingServer(resend.baseUrl, RESEND_EXCHANGE),
        // The outbox's routes are under `/email`, which the fake sender names.
        outbox: await recordingServer(outbox.baseUrl.replace(/\/email$/, ''), EXCHANGE),
        mailgun: await recordingServer(mailgun.baseUrl, MAILGUN_EXCHANGE),
      };
      try {
        configure(servers);
        globalThis.fetch = mailgunStorageAt(servers.mailgun.baseUrl, nodeFetch);
        const transcript = await runEmailParityScript(legacySubject(name), providersOf(servers));
        fixture[name] = {
          transcript,
          exchanges: { resend: servers.resend.exchanges(), outbox: servers.outbox.exchanges(), mailgun: servers.mailgun.exchanges() },
        };
      } finally {
        globalThis.fetch = nodeFetch;
        for (const server of Object.values(servers)) await server.close();
      }
    }
  } finally {
    resend.stop();
    outbox.stop();
    await mailgun.stop();
  }
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
});

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

/** Replay one install against the recording: same answers, same requests. */
async function expectParity(name: InstallName, subjectAt: (servers: Servers) => Promise<EmailParitySubject> | EmailParitySubject): Promise<void> {
  const recorded = loadRecording()[name];
  const servers: Servers = {
    resend: await replayingServer(recorded.exchanges.resend, RESEND_EXCHANGE),
    outbox: await replayingServer(recorded.exchanges.outbox, EXCHANGE),
    mailgun: await replayingServer(recorded.exchanges.mailgun, MAILGUN_EXCHANGE),
  };
  try {
    configure(servers);
    globalThis.fetch = mailgunStorageAt(servers.mailgun.baseUrl, nodeFetch);
    const transcript = await runEmailParityScript(await subjectAt(servers), providersOf(servers));
    expect(transcript).toEqual(recorded.transcript);
    for (const upstream of UPSTREAMS) {
      expect({ upstream, requests: servers[upstream].requests() }).toEqual({ upstream, requests: recorded.exchanges[upstream].map(requestOf) });
    }
  } finally {
    globalThis.fetch = nodeFetch;
    for (const server of Object.values(servers)) await server.close();
  }
}

(recording ? describe.skip : describe)('email recorded parity', () => {
  it('the recording walks the whole surface and every provider was reached', () => {
    const fixture = loadRecording();
    const platform = fixture.platform.exchanges;
    expect(platform.resend.filter((exchange) => exchange.method === 'POST' && exchange.path === '/emails').length).toBe(2);
    expect(platform.resend.some((exchange) => exchange.path.startsWith('/_attachments/'))).toBe(true);
    expect(platform.mailgun.filter((exchange) => exchange.method === 'POST').length).toBe(3);
    expect(platform.mailgun.some((exchange) => exchange.method === 'GET' && exchange.status === 200)).toBe(true);
    expect(platform.outbox.length).toBe(1);
    expect(fixture.process.exchanges.mailgun).toEqual([]);
    for (const name of INSTALLS) {
      expect(fixture[name].transcript.find((entry) => entry.step === 'resolveFileRef resend')?.answer).toEqual({ contentType: 'text/plain', text: 'some notes' });
    }
  });

  it.each(INSTALLS)('the legacy line replays identically (%s)', async (name) => {
    await expectParity(name, () => legacySubject(name));
  });
});
