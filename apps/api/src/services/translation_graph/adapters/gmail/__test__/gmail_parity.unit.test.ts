// Recorded parity for Gmail, on listen-fire 0.13's path, driven through
// `parity/script.ts` against the fake-channels Gmail seeded with
// `PARITY_SEED`: every answer, and every request with what came back. Each
// credential shape has two recordings: a mailbox somebody signed into (its
// stored OAuth tokens), and a mailbox the service account acts as
// (delegated).
//
// - Reads and writes (`gmail_parity_<shape>.json`): the legacy adapter as it
//   was before Gmail became a module (commit 35d33047), trimmed to its reads
//   and writes when 0.13 retired the settings poll. Every request and every
//   answer to a read or a write is the legacy recording's (the module
//   replayed them identically); the schema answers are 0.13's.
// - Polls (`gmail_poll_<shape>.json`): the `Messages` and `Labelings` edges
//   polled as the platform's shared poll does (`poll({ edge, filter?,
//   cursor? })`).
//
// Each implementation is replayed against both and must make the same
// requests (its sends) and give the same answers: the legacy line (reads and
// writes only: it never polled an edge), the module in process as the
// platform loads it (the registry, the platform's Gmail credential over the
// stored row, the platform's files, the dev-loop redirect, the shared poll's
// own poller), and the module served as a process (serve-module) called over
// protocol 2, where a file's bytes cross at URLs.
//
// A send's request is kept as its decoded message, with the random MIME
// boundaries numbered in order and the `Date:` header blanked. Under the
// delegated shape the dev loop never mints a token, so its requests are
// compared without their authentication (the fake reads none).
//
// The requests are compared as a multiset, not in arrival order. Over
// protocol 2 a refusal reaches the caller wrapped by the protocol client; the
// served module is held to its own message inside it.
//
// Re-record the polls (reading the diff): GMAIL_PARITY_RECORD=1 pnpm
// test:unit --testPathPattern gmail_parity. GMAIL_PARITY_RECORD=reads also
// re-records the reads and writes through the legacy line, which since the
// move is the module's adapter over the old credential path: re-recording no
// longer captures the pre-module code.

const mockRow: { app_id: string; payload: Record<string, unknown> } = { app_id: 'gmail-oauth-mailbox', payload: {} };
jest.mock('../../../../../lib/kysely', () => {
  const actual = jest.requireActual('../../../../../lib/kysely');
  const chain: Record<string, unknown> = {};
  for (const name of ['selectFrom', 'where', 'select']) chain[name] = () => chain;
  chain.executeTakeFirst = async () => ({ id: 'cred-parity', credentials: 'ciphertext', app_id: mockRow.app_id });
  return { ...actual, getAutomationsQb: () => chain };
});
jest.mock('../../../../../lib/credentials', () => ({
  ...jest.requireActual('../../../../../lib/credentials'),
  decryptToken: async () => JSON.stringify(mockRow.payload),
}));
// The encrypted store the module line's credential reads through, in memory.
const mockPayloads: Map<string, Record<string, unknown>> = new Map();
jest.mock('../../../../credentials/secrets_postgres', () => {
  const actual = jest.requireActual('../../../../credentials/secrets_postgres');
  const { payloadSecrets } = jest.requireActual('../../../../credentials/__test__/payload_secrets');
  return { ...actual, postgresSecrets: (options: { shape?: unknown }) => payloadSecrets(mockPayloads, options.shape ?? actual.flatPayloadShape) };
});

// The parity team is the dev loop's test-harness team, so every subject is
// redirected to the recording or replaying server exactly as the dev loop
// redirects it to fake-channels.
const mockHarness: { baseUrl?: string } = {};
jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => true,
  injectFakeBaseUrl: (creds: Record<string, unknown>, service: string) =>
    service === 'GOOGLE_GMAIL' && mockHarness.baseUrl !== undefined ? { ...creds, baseUrl: mockHarness.baseUrl } : creds,
}));

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';
import type { DocumentStore } from 'movement-engine/public/files';

import { google } from 'googleapis';

import { servedFiles } from 'module-kit';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
import { DEV_LOOP_GMAIL_TOKEN } from '../../../../../adapters/gmail/apiClient';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { createGmailAdapter } from '../index';
import { edgePollerOf, readPollAnswer } from '../../../../poll_source/edge_poller';
import { recordingServer, replayingServer, requestOf, type Exchange, type ExchangeRequest } from '../../__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import { PARITY_ACCESS_TOKEN, PARITY_MAILBOX, PARITY_SEED, REFUSED, runParityScript, runPollScript, type ParitySubject, type TranscriptEntry } from './parity/script';
import { packageDir, SERVE_MODULE } from '../../__test__/parity/serve_module';

// gaxios finds its fetch (node-fetch) by a dynamic import, which jest's VM
// refuses: the legacy line is handed Node's own fetch instead.
google.options({
  fetchImplementation: async (...args: Parameters<typeof fetch>) => {
    const response = await fetch(...args);
    return new Proxy(response, {
      get(target, key) {
        if (key === 'body') return target.body === null ? null : Readable.fromWeb(target.body as WebReadableStream);
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
});

const TEAM = 'team-parity' as TeamId;
const CREDENTIAL = 'cred-parity';
/** Far from expiry, so no subject ever refreshes. */
const EXPIRES_AT = Date.UTC(2099, 0, 1);
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];

type Shape = 'oauth' | 'delegated';
const SHAPES: readonly Shape[] = ['oauth', 'delegated'];
const fixtureOf = (shape: Shape) => join(__dirname, `__fixtures__/gmail_parity_${shape}.json`);
const pollFixtureOf = (shape: Shape) => join(__dirname, `__fixtures__/gmail_poll_${shape}.json`);

type Run = (subject: ParitySubject) => Promise<TranscriptEntry[]>;

/** The stored row the connect flow writes, by shape. */
function storeRow(shape: Shape): void {
  switch (shape) {
    case 'oauth':
      mockRow.app_id = 'gmail-oauth-mailbox';
      mockRow.payload = { mailbox: PARITY_MAILBOX, accessToken: PARITY_ACCESS_TOKEN, refreshToken: 'parity-refresh', expiresAt: EXPIRES_AT, grantedScopes: SCOPES };
      break;
    case 'delegated':
      mockRow.app_id = 'gmail-delegated';
      mockRow.payload = { mailbox: PARITY_MAILBOX };
      break;
  }
  mockPayloads.clear();
  mockPayloads.set(CREDENTIAL, { ...mockRow.payload });
}

/** What a host other than the platform holds for the install, by shape: the
 *  fields the module reads. */
function vaultFields(shape: Shape): Record<string, string> {
  switch (shape) {
    case 'oauth':
      return {
        mailbox: PARITY_MAILBOX,
        access_token: PARITY_ACCESS_TOKEN,
        refresh_token: 'parity-refresh',
        expires_at: new Date(EXPIRES_AT).toISOString(),
        granted_scopes: SCOPES.join(' '),
      };
    case 'delegated':
      return { mailbox: PARITY_MAILBOX, method: 'delegated', access_token: DEV_LOOP_GMAIL_TOKEN, send_access_token: DEV_LOOP_GMAIL_TOKEN };
  }
}

/** `serve-module @lf/gmail` as a child process. */
async function serveGmail(env: Record<string, string>): Promise<{ url: string; stop(): void }> {
  const child = spawn(process.execPath, [SERVE_MODULE, '.'], {
    cwd: packageDir('@listen-fire/gmail'),
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve-module printed no port within 30s')), 30_000);
    child.once('exit', (code) => reject(new Error(`serve-module exited (${code})`)));
    if (child.stdout === null) return;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const match = /^listening (\d+)$/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}

/** The host's document store, as far as a send to a served module needs it:
 *  the bytes of a file the send hands over, held at a URL for one fetch. */
async function exposingDocuments(): Promise<{ documents: DocumentStore; close(): Promise<void> }> {
  const files = servedFiles();
  const server = createServer((req, res) => {
    if (!files.serve(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  const refuse = async (): Promise<never> => {
    throw new Error('the parity documents store keeps nothing');
  };
  return {
    documents: {
      put: refuse,
      owns: async () => false,
      open: refuse,
      expose: async ({ stream, contentType }) => ({ url: files.expose({ stream, ...(contentType !== undefined ? { contentType } : {}) }, origin) }),
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** A refusal as the protocol client reports it: the module's own message,
 *  behind the client's `Remote adapter error for method "…": <code> — `. */
const REMOTE_ERROR = /^Remote adapter error for method "[^"]+": [a-z_]+ — /;

/**
 * What protocol 2 does not carry today, taken out of the recording before a
 * served module is compared with it, and nothing else: a file's `size` once
 * its bytes are read (the wire `resolveFileRef` answers a url and a content
 * type). A gap in the protocol, not in the module.
 */
function withoutProtocol2Gaps(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript.map((entry) => {
    const answer = entry.answer;
    if (answer === null || typeof answer !== 'object' || !('base64' in answer)) return entry;
    return { ...entry, answer: { ...answer, size: null } };
  });
}

function unwrapRemoteErrors(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript.map((entry) => {
    const error: unknown = entry.answer !== null && typeof entry.answer === 'object' ? Reflect.get(entry.answer, 'error') : undefined;
    return typeof error === 'string' ? { ...entry, answer: { error: error.replace(REMOTE_ERROR, '') } } : entry;
  });
}

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

const BOUNDARY = /=_listen_fire_[0-9a-f]{32}/g;

/** A send as its message: boundaries numbered in order, the time blanked. */
function normalizeSend(request: ExchangeRequest): ExchangeRequest {
  const body = request.body;
  const raw: unknown = body !== null && typeof body === 'object' ? Reflect.get(body, 'raw') : undefined;
  if (typeof raw !== 'string') return request;
  const numbered = new Map<string, string>();
  const message = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .replace(BOUNDARY, (boundary) => {
      if (!numbered.has(boundary)) numbered.set(boundary, `=_boundary_${numbered.size + 1}`);
      return numbered.get(boundary) ?? boundary;
    })
    .replace(/^Date: .*$/m, 'Date: <date>');
  return { ...request, body: { ...Object.fromEntries(Object.entries(body ?? {})), raw: message } };
}

/** Delegated, under the dev loop: no token was ever minted, so the request's
 *  authentication is not part of what is compared. */
function withoutAuth(request: ExchangeRequest): ExchangeRequest {
  const path = request.path.replace(/([?&])key=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return { ...request, path, authorization: null };
}

const normalizerOf = (shape: Shape) => (shape === 'delegated' ? (r: ExchangeRequest) => withoutAuth(normalizeSend(r)) : normalizeSend);

/** The legacy line: its adapter over the old credential path (the stored row
 *  is the one thing replaced). It reads and writes; it polls no edge. */
function legacySubject(shape: Shape, baseUrl: string): Pick<ParitySubject, 'adapter'> {
  storeRow(shape);
  mockHarness.baseUrl = baseUrl;
  return { adapter: () => createGmailAdapter({ teamId: TEAM, credentialsId: CREDENTIAL }) };
}

const INSTALL = { adapterType: 'gmail', teamId: TEAM, credentialsId: CREDENTIAL };

/** The module in process as the platform loads it: reads through the
 *  registry, polls through the shared poll's own poller. */
async function inProcessSubject(shape: Shape, baseUrl: string): Promise<ParitySubject> {
  storeRow(shape);
  mockHarness.baseUrl = baseUrl;
  const poll = await edgePollerOf(INSTALL);
  if (poll === null) throw new Error('gmail polls no edge');
  return { adapter: () => getAdapter(INSTALL), poll };
}

jest.setTimeout(180_000);

const recording = process.env.GMAIL_PARITY_RECORD;
const previousAllowlist = process.env.GMAIL_MAILBOX_ALLOWLIST;
beforeAll(() => {
  // Delegation refuses every mailbox while the list is unset.
  process.env.GMAIL_MAILBOX_ALLOWLIST = PARITY_MAILBOX;
});
afterAll(() => {
  if (previousAllowlist === undefined) delete process.env.GMAIL_MAILBOX_ALLOWLIST;
  else process.env.GMAIL_MAILBOX_ALLOWLIST = previousAllowlist;
});

describe.each(SHAPES)('gmail recorded parity (%s)', (shape) => {
  (recording !== undefined ? it : it.skip)('records against fake-channels', async () => {
    const record = async (file: string, run: (baseUrl: string) => Promise<TranscriptEntry[]>) => {
      const fake = await bootFakeChannels({ file: 'gmail', factory: 'gmailRoutes', mount: '/' });
      try {
        for (const message of PARITY_SEED) {
          const seeded = await fetch(`${fake.baseUrl}/fake-gmail/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(message),
          });
          if (!seeded.ok) throw new Error(`seeding ${String(message.id)} failed: ${seeded.status}`);
        }
        const proxy = await recordingServer(fake.baseUrl, { normalize: normalizerOf(shape) });
        try {
          const transcript = await run(proxy.baseUrl);
          const fixture: Recording = { transcript, exchanges: proxy.exchanges() };
          writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
        } finally {
          await proxy.close();
        }
      } finally {
        fake.stop();
      }
    };
    if (recording === 'reads') await record(fixtureOf(shape), (baseUrl) => runParityScript(legacySubject(shape, baseUrl)));
    await record(pollFixtureOf(shape), async (baseUrl) => runPollScript(await inProcessSubject(shape, baseUrl)));
  });

  const loadRecording = (file = fixtureOf(shape)): Recording => JSON.parse(readFileSync(file, 'utf8')) as Recording;
  const asMultiset = (requests: readonly ExchangeRequest[]): string[] => requests.map((request) => JSON.stringify(request)).sort();

  async function expectParity(
    file: string,
    run: Run,
    subjectAt: (baseUrl: string) => Promise<ParitySubject> | ParitySubject,
    options: { remote?: boolean } = {},
  ): Promise<void> {
    const recorded = loadRecording(file);
    const server = await replayingServer(recorded.exchanges, { normalize: normalizerOf(shape) });
    try {
      const answered = await run(await subjectAt(server.baseUrl));
      const transcript = options.remote === true ? unwrapRemoteErrors(answered) : answered;
      expect(transcript).toEqual(options.remote === true ? withoutProtocol2Gaps(recorded.transcript) : recorded.transcript);
      expect(asMultiset(server.requests())).toEqual(asMultiset(recorded.exchanges.map(requestOf)));
    } finally {
      await server.close();
    }
  }

  const RECORDINGS = [
    ['reads and writes', fixtureOf(shape), runParityScript],
    ['polls of Messages and Labelings', pollFixtureOf(shape), runPollScript],
  ] as const;

  (recording !== undefined ? describe.skip : describe)('replay', () => {
    it.each(RECORDINGS)('%s: the recording walks the whole surface and fails only where it should', (_name, file) => {
      const { transcript } = loadRecording(file);
      const failed = (entry: TranscriptEntry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer;
      expect(transcript.filter((entry) => failed(entry) !== entry.step.startsWith(REFUSED)).map((entry) => entry.step)).toEqual([]);
    });

    it('the polls arm on a first look, deliver from a mark, and carry what the search has not admitted yet', () => {
      const { transcript } = loadRecording(pollFixtureOf(shape));
      const answerOf = (step: string) => transcript.find((e) => e.step === step)?.answer;
      expect(answerOf('first poll sets the mark')).toMatchObject({ arrivals: [], cursor: { lastSeenAt: '<now>' } });
      expect(answerOf('poll from the mark')).toMatchObject({ arrivals: expect.arrayContaining([expect.objectContaining({ edge: 'Messages' })]) });
      expect(answerOf('poll taking its Query')).toMatchObject({ arrivals: expect.arrayContaining([expect.objectContaining({ takenApplied: true })]) });
    });

    it('the legacy line replays the reads and writes identically', async () => {
      await expectParity(fixtureOf(shape), runParityScript, (baseUrl) => ({ ...legacySubject(shape, baseUrl), poll: async () => ({ arrivals: [] }) }));
    });

    it.each(RECORDINGS)('%s: the module in process, as the platform loads it, replays identically', async (_name, file, run) => {
      expect(BUILTIN_MODULES.gmail?.line).toBe('module');
      await expectParity(file, run, (baseUrl) => inProcessSubject(shape, baseUrl));
    });

    it.each(RECORDINGS)('%s: the module served as a process, over protocol 2, replays identically', async (_name, file, run) => {
      const served: Array<{ stop(): void }> = [];
      const exposing = await exposingDocuments();
      try {
        await expectParity(file, run, async (baseUrl) => {
          const gmail = await serveGmail({ MODULE_BASE_URL_OVERRIDE: baseUrl });
          served.push(gmail);
          const secrets = createSecretsFamily({ backend: createMemoryVault({ [CREDENTIAL]: vaultFields(shape) }) });
          const config = { adapterType: 'gmail', teamId: TEAM, baseUrl: gmail.url, authStrategy: { kind: 'bearer' as const }, credentialsId: CREDENTIAL };
          const manifest = await fetchRemoteManifest(config, '');
          const remote = (): Adapter & { poll(input: unknown): Promise<unknown> } =>
            createRemoteAdapter({
              config,
              secret: '',
              cacheScopeId: 'parity',
              manifest,
              documents: exposing.documents,
              credential: { name: 'gmail', secrets, ref: CREDENTIAL },
            });
          return { adapter: remote, poll: async (input) => readPollAnswer('gmail', await remote().poll(input)) };
        }, { remote: true });
      } finally {
        for (const process of served) process.stop();
        await exposing.close();
      }
    });
  });
});
