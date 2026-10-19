// Recorded parity for WhatsApp. The fixture is the legacy adapter as it was
// before WhatsApp became a module, driven through `parity/script.ts` against
// the fake-channels Meta Cloud API: every answer, and every request it made
// with what came back. WhatsApp takes no team credential: the platform's one
// Meta app (`WHATSAPP_*`) sends for every team, from the number a message
// arrived on (the movements number here, the primary for a number it does not
// know), and the Meta door's media reach the adapter at the platform's
// exposed-file URLs, served here beside the fake.
// Each implementation is replayed against the recording and must make the
// same requests (its writes) and give the same answers: the legacy line, the
// module in process through the platform's registry (the shared app reaching
// it as its credential), and the module served as a process with the same
// app as a user's own credential.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// WHATSAPP_PARITY_RECORD=1 pnpm test:unit --testPathPattern whatsapp_parity

import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Exchange } from '../../__test__/parity/exchange';
import type { TranscriptEntry, WhatsappParitySubject } from './parity/script';

import { MOVEMENTS_NUMBER_ID, PARITY_TWILIO_ACCOUNT, PRIMARY_NUMBER_ID, runWhatsappParityScript } from './parity/script';
import { recordingServer, replayingServer, requestOf } from '../../__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';

// `mime` is an ES module, which this jest runtime cannot load; the adapter
// reads it with a dynamic import. Answer from the real library, run by Node.
jest.mock('mime', () => ({
  __esModule: true,
  default: {
    getExtension: (type: string): string | null => {
      const { execFileSync } = jest.requireActual('node:child_process');
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import mime from 'mime'; process.stdout.write(JSON.stringify(mime.getExtension(${JSON.stringify(type)})))`], { cwd: __dirname });
      return JSON.parse(String(out));
    },
  },
}));

const FIXTURE = join(__dirname, '__fixtures__/whatsapp_parity.json');
const TEAM = 'team-parity' as TeamId;
const ACCESS_TOKEN = 'PARITY-META-TOKEN';
/** The bytes the platform's exposed-file route serves for the Meta door's
 *  downloaded media. */
const DECK = { contentType: 'application/pdf', body: '%PDF-1.4 the parity deck' };

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Forward every request, byte for byte, to `target()`. The legacy line reads
 *  where Meta is when it is first imported, so the adapter is pointed here
 *  once and this forwards to the recording or replaying server of the run. */
async function switchboard(target: () => string): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'authorization']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const answer = await fetch(target() + (req.url ?? '/'), { method: req.method ?? 'GET', headers, ...(raw.length > 0 ? { body: raw } : {}) });
      const contentType = answer.headers.get('content-type');
      res.writeHead(answer.status, contentType !== null ? { 'content-type': contentType } : {});
      res.end(Buffer.from(await answer.arrayBuffer()));
    })();
  });
  const baseUrl = await listen(server);
  return { baseUrl, close: () => close(server) };
}

/** The provider while recording: the platform's exposed files, and the
 *  fake-channels Meta Cloud API (mounted at `/whatsapp`) for the rest. */
async function upstream(fakeRoot: string): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      if ((req.url ?? '').startsWith('/api/files/blob/')) {
        res.writeHead(200, { 'content-type': DECK.contentType });
        res.end(DECK.body);
        return;
      }
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'authorization']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const answer = await fetch(fakeRoot + (req.url ?? '/'), { method: req.method ?? 'GET', headers, ...(raw.length > 0 ? { body: raw } : {}) });
      const contentType = answer.headers.get('content-type');
      res.writeHead(answer.status, contentType !== null ? { 'content-type': contentType } : {});
      res.end(Buffer.from(await answer.arrayBuffer()));
    })();
  });
  const baseUrl = await listen(server);
  return { baseUrl, close: () => close(server) };
}

const ENV = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID',
  'WHATSAPP_GRAPH_BASE_URL',
  'EXPOSED_FILE_PUBLIC_BASE_URL',
  'TWILIO_ACCOUNT_SID',
] as const;
const savedEnv: Partial<Record<(typeof ENV)[number], string>> = {};

let target = '';
let board: { baseUrl: string; close(): Promise<void> };

jest.setTimeout(120_000);

beforeAll(async () => {
  board = await switchboard(() => target);
  for (const name of ENV) {
    const value = process.env[name];
    if (value !== undefined) savedEnv[name] = value;
  }
  // The deployment's WhatsApp configuration, as the legacy line reads it.
  process.env.WHATSAPP_ACCESS_TOKEN = ACCESS_TOKEN;
  process.env.WHATSAPP_PHONE_NUMBER_ID = PRIMARY_NUMBER_ID;
  process.env.WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID = MOVEMENTS_NUMBER_ID;
  process.env.WHATSAPP_GRAPH_BASE_URL = `${board.baseUrl}/whatsapp/graph`;
  process.env.EXPOSED_FILE_PUBLIC_BASE_URL = board.baseUrl;
  process.env.TWILIO_ACCOUNT_SID = PARITY_TWILIO_ACCOUNT;
});

afterAll(async () => {
  for (const name of ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await board.close();
});

/** The legacy line, as the registry constructs it. Required only once the
 *  environment above is set: the Meta clients are built when first imported. */
function legacySubject(): WhatsappParitySubject {
  const { WhatsappAdapter }: typeof import('../index') = require('../index');
  return { adapter: new WhatsappAdapter(TEAM), baseUrl: board.baseUrl, hostFiles: true };
}

const recording = process.env.WHATSAPP_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against fake-channels', async () => {
  const fake = await bootFakeChannels({ file: 'whatsapp', factory: 'whatsappRoutes', mount: '/whatsapp' });
  const provider = await upstream(fake.baseUrl.replace(/\/whatsapp$/, ''));
  const proxy = await recordingServer(provider.baseUrl);
  try {
    target = proxy.baseUrl;
    const transcript = await runWhatsappParityScript(legacySubject());
    const fixture: Recording = { transcript, exchanges: proxy.exchanges() };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await proxy.close();
    await provider.close();
    fake.stop();
  }
});

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

/** Replay against the recording: same answers, same requests. */
async function expectParity(subject: () => Promise<WhatsappParitySubject> | WhatsappParitySubject): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges);
  try {
    target = server.baseUrl;
    const transcript = await runWhatsappParityScript(await subject());
    expect(transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(requestOf));
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('whatsapp recorded parity', () => {
  it('the recording walks the whole surface and every send reached the provider', () => {
    const { exchanges, transcript } = loadRecording();
    const sends = exchanges.filter((exchange) => exchange.path.endsWith('/messages'));
    // Typing, a reaction, four replies and an interactive one, one with a file.
    expect(sends.length).toBe(7);
    expect(sends.every((exchange) => exchange.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
    // A reply goes out from the number its message arrived on; an unknown
    // number's, or a sent message's, from the primary.
    expect(sends.filter((exchange) => exchange.path.includes(PRIMARY_NUMBER_ID)).length).toBe(2);
    expect(exchanges.some((exchange) => exchange.path.endsWith('/media'))).toBe(true);
    expect(exchanges.some((exchange) => exchange.path.startsWith('/api/files/blob/'))).toBe(true);
    const answers = new Map(transcript.map((entry) => [entry.step, entry.answer]));
    expect(answers.get('resolveFileRef exposed')).toEqual({ contentType: DECK.contentType, text: DECK.body });
    expect(answers.get('reply with the file')).toMatchObject({ externalId: expect.stringMatching(/^wamid\.fake_/) });
  });

  it('the legacy line replays identically', async () => {
    await expectParity(legacySubject);
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.whatsapp?.line).toBe('module');
    await expectParity(() => ({ adapter: getAdapter({ adapterType: 'whatsapp', teamId: TEAM }), baseUrl: board.baseUrl, hostFiles: true }));
  });

  // A process host exposes no files of its own and redeems none in process,
  // so the steps that fetch an exposed file or send one are not run; every
  // other answer and request is the recording's.
  it('the module served as a process, over protocol 2, replays identically (no host files)', async () => {
    const recorded = loadRecording();
    const served = await serveWhatsapp();
    const server = await replayingServer(recorded.exchanges);
    const nodeFetch = globalThis.fetch;
    globalThis.fetch = sameRealmFetch(nodeFetch);
    try {
      target = server.baseUrl;
      const fields = {
        accessToken: ACCESS_TOKEN,
        phoneNumberId: PRIMARY_NUMBER_ID,
        movementsPhoneNumberId: MOVEMENTS_NUMBER_ID,
        baseUrl: `${board.baseUrl}/whatsapp/graph`,
        twilioAccountSid: PARITY_TWILIO_ACCOUNT,
      };
      const credentials = createMemoryVault({ 'cred-own': fields });
      const config = { adapterType: 'whatsapp', teamId: TEAM, baseUrl: served.url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-own' };
      const remote = createRemoteAdapter({
        config,
        secret: '',
        cacheScopeId: 'parity',
        manifest: await fetchRemoteManifest(config, ''),
        documents: { put: async () => ({}) } as never,
        credential: { name: 'whatsapp', secrets: createSecretsFamily({ backend: credentials }), ref: 'cred-own' },
      });
      const transcript = (await runWhatsappParityScript({ adapter: remote, baseUrl: board.baseUrl, hostFiles: false })).map(unwrapRemoteError).map(unnamedInstall);
      const withoutHostFiles = new Set(['resolveFileRef exposed', 'reply with the file']);
      expect(transcript).toEqual(recorded.transcript.filter((entry) => !withoutHostFiles.has(entry.step)));
      const hostFileRequests = (exchange: Exchange) =>
        !exchange.path.startsWith('/api/files/blob/') && !exchange.path.endsWith('/media') && !JSON.stringify(exchange.body).includes('upload_');
      expect(server.requests()).toEqual(recorded.exchanges.filter(hostFileRequests).map(requestOf));
    } finally {
      globalThis.fetch = nodeFetch;
      await server.close();
      served.stop();
    }
  });
});

/** A file as the module named it: over the process transport the client
 *  names the install a file belongs to (its credential), which an install
 *  with no credential, as on the platform, does not carry. */
function unnamedInstall(entry: TranscriptEntry): TranscriptEntry {
  return JSON.parse(JSON.stringify(entry).split(',"credentialId":"cred-own"').join('')) as TranscriptEntry;
}

/** A refusal as the module raised it: the client wraps every error the wire
 *  carries in its method and code, which says nothing about the module. */
function unwrapRemoteError(entry: TranscriptEntry): TranscriptEntry {
  const answer = entry.answer;
  if (answer === null || typeof answer !== 'object' || !('error' in answer) || typeof answer.error !== 'string') return entry;
  const match = /^Remote adapter error for method "[^"]+": [a-z_]+ — (.*)$/s.exec(answer.error);
  return match?.[1] === undefined ? entry : { ...entry, answer: { error: match[1] } };
}

/**
 * Jest runs this file in a realm of its own, and `fetch` answers in Node's:
 * the objects of a parsed answer then fail the engine's plain-object check,
 * which compares prototypes (engine-contracts `isPlainObject`). Production has
 * one realm. Parse each answer here instead.
 */
function sameRealmFetch(nodeFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await nodeFetch(input, init);
    const body = await res.text();
    return Object.assign(new Response(body, { status: res.status, headers: res.headers }), {
      json: async (): Promise<unknown> => JSON.parse(body),
    });
  };
}

/** `serve-module @lf/whatsapp` as a child process. */
async function serveWhatsapp(): Promise<{ url: string; stop(): void }> {
  const repo = join(__dirname, '../../../../../../../..');
  const child = spawn(process.execPath, [join(repo, 'packages/module-kit/bin/serve-module.cjs'), '.'], {
    cwd: join(repo, 'modules/whatsapp'),
    env: { ...process.env, PORT: '0' },
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
