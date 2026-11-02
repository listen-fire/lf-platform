// Recorded parity for Evertrace, on listen-fire 0.13's path. Two recordings,
// both driven against the fake-channels Evertrace:
//
// - Reads and writes (`evertrace_parity.json`): the legacy adapter's answers
//   and requests as recorded before Evertrace became a module, trimmed to the
//   reads and writes when 0.13 retired the settings poll. Every request and
//   every answer to a read or write is the legacy recording's (the module
//   replayed them identically); the schema answers (entry points, describes,
//   the root's edges) are 0.13's, and the fields 0.13 newly declares (`Id`,
//   `Saved Search`, `List Id`, `List Name`) are read too. The legacy script
//   also polled once after creating a list entry; that poll is gone with the
//   settings poll, and the polls below start from a fresh seed.
// - Polls (`evertrace_poll.json`): the `Signals` and `List Entries` edges
//   polled as the platform's shared poll does (`poll({ edge, filter?,
//   cursor? })`), a saved search or a list taken from the filter.
//
// Each implementation is replayed against both and must make the same
// requests (its writes included) and give the same answers: the module in
// process as the platform loads it (the registry, and the shared poll's own
// poller), and the module served as a process (serve-module) and called over
// adapter protocol 2. The clock is fixed: a new saved search is stamped from
// it, and a first poll takes its mark from it.
//
// Re-record the polls (reading the diff): EVERTRACE_PARITY_RECORD=1 pnpm
// test:unit --testPathPattern evertrace_parity. Re-recording the reads and
// writes replaces the legacy line's answers with the module's:
// EVERTRACE_PARITY_RECORD=reads.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

// The platform's encrypted store, as a vault the test seeds: the module line
// reads its credential through the secrets family exactly as in production.
const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../../credentials/secrets_postgres'),
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { createMemoryVault, createSecretsFamily } from 'movement-engine/public/secrets';
import { createRemoteAdapter, fetchRemoteManifest } from 'movement-engine/public/modules';
import { getAdapter } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';
import { edgePollerOf, readPollAnswer } from '../../../../poll_source/edge_poller';
import { recordingServer, replayingServer, type Exchange } from '../../__test__/parity/exchange';
import { bootFakeEvertrace } from './parity/fake_evertrace';
import { FIXED_NOW } from './parity/fixed_clock.cjs';
import { runParityScript, runPollScript, type ParitySubject, type TranscriptEntry } from './parity/script';
import { packageDir, SERVE_MODULE } from '../../__test__/parity/serve_module';

const READS = join(__dirname, '__fixtures__/evertrace_parity.json');
const POLLS = join(__dirname, '__fixtures__/evertrace_poll.json');
/** The version header the provider refuses a request without. */
const TRACKED = { headers: ['x-api-version'] };
const API_KEY = 'dev-loop-evertrace-key';
const TEAM = 'team-parity' as TeamId;
const INSTALL = { adapterType: 'evertrace', teamId: TEAM, credentialsId: 'cred-parity' };

interface Recording {
  transcript: TranscriptEntry[];
  exchanges: Exchange[];
}

/** The module in process as the platform loads it, its credential pointed at
 *  `baseUrl`: reads through the registry, polls through the shared poll's
 *  own poller. */
async function inProcessSubject(baseUrl: string): Promise<ParitySubject> {
  vault.current = createMemoryVault({ 'cred-parity': { apiKey: API_KEY, baseUrl } });
  const poll = await edgePollerOf(INSTALL);
  if (poll === null) throw new Error('evertrace polls no edge');
  return { adapter: getAdapter(INSTALL), poll };
}

jest.setTimeout(120_000);

const recording = process.env.EVERTRACE_PARITY_RECORD;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
});
afterEach(() => {
  jest.restoreAllMocks();
});

(recording !== undefined ? it : it.skip)('records the module against fake-channels', async () => {
  // Each recording on a freshly seeded fake: the writes change what a poll finds.
  const record = async (file: string, run: (subject: ParitySubject) => Promise<TranscriptEntry[]>) => {
    const fake = await bootFakeEvertrace();
    const proxy = await recordingServer(fake.baseUrl, TRACKED);
    try {
      const transcript = await run(await inProcessSubject(proxy.baseUrl));
      writeFileSync(file, `${JSON.stringify({ transcript, exchanges: proxy.exchanges() }, null, 2)}\n`);
    } finally {
      await proxy.close();
      fake.stop();
    }
  };
  if (recording === 'reads') await record(READS, runParityScript);
  await record(POLLS, runPollScript);
});

function loadRecording(file: string): Recording {
  return JSON.parse(readFileSync(file, 'utf8')) as Recording;
}

/** What the protocol client puts in front of an adapter's own error message. */
const REMOTE_ERROR_PREFIX = /^Remote adapter error for method "[^"]+": adapter_error — /;

/** A refusal over the wire is the adapter's message behind the transport's
 *  prefix; the parity held is of the message itself. */
function withoutTransportPrefix(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript.map((entry) => {
    const answer = entry.answer;
    if (answer !== null && typeof answer === 'object' && 'error' in answer && typeof answer.error === 'string') {
      return { ...entry, answer: { ...answer, error: answer.error.replace(REMOTE_ERROR_PREFIX, '') } };
    }
    return entry;
  });
}

/** Replay `subjectAt` against a recording: same answers, same requests. */
async function expectParity(
  file: string,
  run: (subject: ParitySubject) => Promise<TranscriptEntry[]>,
  subjectAt: (baseUrl: string) => Promise<ParitySubject>,
  options: { overProtocol?: boolean } = {},
): Promise<void> {
  const recorded = loadRecording(file);
  const server = await replayingServer(recorded.exchanges, TRACKED);
  try {
    const transcript = await run(await subjectAt(server.baseUrl));
    expect(options.overProtocol === true ? withoutTransportPrefix(transcript) : transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
  } finally {
    await server.close();
  }
}

const RECORDINGS = [
  ['reads and writes', READS, runParityScript],
  ['polls of Signals and List Entries', POLLS, runPollScript],
] as const;

(recording !== undefined ? describe.skip : describe)('evertrace recorded parity', () => {
  it('the reads and writes walk the whole surface', () => {
    const { transcript, exchanges } = loadRecording(READS);
    const failed = transcript
      .filter((entry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer)
      .map((entry) => entry.step);
    // The refusals the script probes on purpose; nothing else fails.
    expect(failed.filter((step) => !/Nonexistent|bad filter|no title|no name|one end|create Signal|create Company|List Entry$|bare id|unknown|delete Search missing|update Signal Viewed false|delete Signal/.test(step))).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(40);
  });

  it('the polls deliver arrivals from a cursor, take a saved search or a list, arm on a first look and refuse an edge they do not poll', () => {
    const { transcript } = loadRecording(POLLS);
    const answerOf = (step: string) => transcript.find((e) => e.step === step)?.answer;
    expect(answerOf('poll first look (Signals)')).toEqual({ arrivals: [], cursor: { createdAfter: FIXED_NOW } });
    expect(answerOf('poll Signals from the start')).toMatchObject({ arrivals: expect.arrayContaining([expect.objectContaining({ edge: 'Signals' })]) });
    expect(answerOf('poll Signals of a saved search (title)')).toMatchObject({ arrivals: expect.arrayContaining([expect.objectContaining({ takenApplied: true })]) });
    expect(answerOf('poll List Entries from the start')).toMatchObject({ arrivals: expect.arrayContaining([expect.objectContaining({ edge: 'List Entries' })]) });
    expect(answerOf('poll List Entries past the newest')).toMatchObject({ arrivals: [] });
    expect(answerOf('poll an edge that is not polled')).toMatchObject({ error: expect.stringContaining('no edge Companies') });
  });

  it('the module line is the one the platform loads', () => {
    expect(BUILTIN_MODULES.evertrace?.line).toBe('module');
  });

  it.each(RECORDINGS)('%s: the module in process, as the platform loads it, replays identically', async (_name, file, run) => {
    await expectParity(file, run, inProcessSubject);
  });

  it.each(RECORDINGS)('%s: the module served as a process, over protocol 2, replays identically', async (_name, file, run) => {
    const served = await serveEvertrace();
    try {
      await expectParity(file, run, async (baseUrl) => {
        const credentials = createMemoryVault({ 'cred-parity': { apiKey: API_KEY, baseUrl } });
        const config = { adapterType: 'evertrace', teamId: TEAM, baseUrl: served.url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-parity' };
        const remote = createRemoteAdapter({
          config,
          secret: '',
          cacheScopeId: 'parity',
          manifest: await fetchRemoteManifest(config, ''),
          documents: { put: async () => ({}) } as never,
          credential: { name: 'evertrace', secrets: createSecretsFamily({ backend: credentials }), ref: 'cred-parity' },
        });
        return { adapter: remote, poll: async (input) => readPollAnswer('evertrace', await remote.poll(input)) };
      }, { overProtocol: true });
    } finally {
      served.stop();
    }
  });
});

/** `serve-module @lf/evertrace` as a child process, on the recording's clock. */
async function serveEvertrace(): Promise<{ url: string; stop(): void }> {
  const child = spawn(process.execPath, ['--require', join(__dirname, 'parity/fixed_clock.cjs'), SERVE_MODULE, '.'], {
    cwd: packageDir('@listen-fire/evertrace'),
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
