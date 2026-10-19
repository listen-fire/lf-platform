// Recorded parity for WhatsApp. The fixture is the legacy adapter as it was
// before WhatsApp became a module, driven through `parity/script.ts` against
// the fake-channels Meta Cloud API: every answer, and every request it made
// with what came back. WhatsApp takes no team credential: the platform's one
// Meta app (`WHATSAPP_*`) sends for every team, from the number a message
// arrived on (the movements number here, the primary for a number it does not
// know), and the Meta door's media reach the adapter at the platform's
// exposed-file URLs, served here beside the fake.
// Each implementation is replayed against the recording and must make the
// same requests (its writes) and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// WHATSAPP_PARITY_RECORD=1 pnpm test:unit --testPathPattern whatsapp_parity

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { Exchange } from '../../__test__/parity/exchange';
import type { TranscriptEntry, WhatsappParitySubject } from './parity/script';

import { MOVEMENTS_NUMBER_ID, PARITY_TWILIO_ACCOUNT, PRIMARY_NUMBER_ID, runWhatsappParityScript } from './parity/script';
import { recordingServer, replayingServer, requestOf } from '../../__test__/parity/exchange';
import { bootFakeChannels } from '../../__test__/parity/fake_channels';

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
});
