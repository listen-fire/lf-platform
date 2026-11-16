// Recorded parity for Granola, on listen-fire 0.13's path. Two recordings,
// both driven against the fake-channels Granola:
//
// - Reads (`granola_parity.json`): the legacy adapter's answers and requests
//   as recorded before Granola became a module, trimmed to the reads when
//   0.13 retired the settings poll. Every request and every field read is the
//   legacy recording's (the module replayed them identically); the schema
//   answers (entry points, describes, the root's edges) and each landed
//   note's position, which now keeps its folder ids, are 0.13's.
// - Polls (`granola_poll.json`): the `Meetings` edge polled as the platform's
//   shared poll does (`poll({ edge, filter?, cursor? })`), and each arrival's
//   actor read from the trigger event the platform starts its run with.
//
// Each implementation is replayed against both and must make the same
// requests and give the same answers: the module in process as the platform
// loads it (the registry, and the shared poll's own poller), and the module
// served as a process (serve-module) and called over adapter protocol 2.
//
// Re-record the polls (reading the diff): GRANOLA_PARITY_RECORD=1 pnpm
// test:unit --testPathPattern granola_parity. Re-recording the reads replaces
// the legacy line's answers with the module's: GRANOLA_PARITY_RECORD=reads.

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
import { bootFakeGranola } from './parity/fake_granola';
import { runParityScript, runPollScript, type ParitySubject, type TranscriptEntry } from './parity/script';
import { packageDir, SERVE_MODULE } from '../../__test__/parity/serve_module';

const READS = join(__dirname, '__fixtures__/granola_parity.json');
const POLLS = join(__dirname, '__fixtures__/granola_poll.json');
const API_KEY = 'dev-loop-granola-token';
const TEAM = 'team-parity' as TeamId;
const INSTALL = { adapterType: 'granola', teamId: TEAM, credentialsId: 'cred-parity' };

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
  if (poll === null) throw new Error('granola polls no edge');
  return { adapter: getAdapter(INSTALL), poll };
}

jest.setTimeout(120_000);

const recording = process.env.GRANOLA_PARITY_RECORD;

(recording !== undefined ? it : it.skip)('records the module against fake-channels', async () => {
  const fake = await bootFakeGranola();
  try {
    const record = async (file: string, run: (subject: ParitySubject) => Promise<TranscriptEntry[]>) => {
      const proxy = await recordingServer(fake.baseUrl);
      try {
        const transcript = await run(await inProcessSubject(proxy.baseUrl));
        writeFileSync(file, `${JSON.stringify({ transcript, exchanges: proxy.exchanges() }, null, 2)}\n`);
      } finally {
        await proxy.close();
      }
    };
    if (recording === 'reads') await record(READS, runParityScript);
    await record(POLLS, runPollScript);
  } finally {
    fake.stop();
  }
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
  const server = await replayingServer(recorded.exchanges);
  try {
    const transcript = await run(await subjectAt(server.baseUrl));
    expect(options.overProtocol === true ? withoutTransportPrefix(transcript) : transcript).toEqual(recorded.transcript);
    expect(server.requests()).toEqual(recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request));
  } finally {
    await server.close();
  }
}

const RECORDINGS = [
  ['reads', READS, runParityScript],
  ['polls of Meetings', POLLS, runPollScript],
] as const;

(recording !== undefined ? describe.skip : describe)('granola recorded parity', () => {
  it('the reads walk the whole surface and fail only where the script probes a field that is not there', () => {
    const { transcript, exchanges } = loadRecording(READS);
    const failed = transcript
      .filter((entry) => entry.answer !== null && typeof entry.answer === 'object' && 'error' in entry.answer)
      .map((entry) => entry.step);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.filter((step) => !/\.(Nonexistent|granola_note_id)$/.test(step))).toEqual([]);
    expect(exchanges.length).toBeGreaterThan(15);
  });

  it('the polls deliver arrivals from a cursor, take a filter, arm on a first look and refuse an edge they do not poll', () => {
    const { transcript } = loadRecording(POLLS);
    const answerOf = (step: string) => transcript.find((e) => e.step === step)?.answer;
    expect(answerOf('poll first look')).toEqual({ arrivals: [], cursor: 'string' });
    expect(answerOf('poll from a cursor')).toMatchObject({ arrivals: expect.arrayContaining([expect.objectContaining({ edge: 'Meetings' })]) });
    expect(answerOf('poll taking Title ==')).toMatchObject({ arrivals: [expect.objectContaining({ takenApplied: true })] });
    expect(answerOf('poll past the newest')).toMatchObject({ arrivals: [] });
    expect(answerOf('poll an edge that is not polled')).toMatchObject({ error: expect.stringContaining('no edge Attendees') });
  });

  // Who acted rides on the arrival (adapter protocol 2.7): the run's trigger
  // carries it, and the module reads it from there.
  it("a polled meeting names its note owner as the `Note Owner Email` claim", () => {
    const { transcript } = loadRecording(POLLS);
    expect(transcript.find((e) => e.step === 'poll from a cursor')?.answer).toMatchObject({
      arrivals: expect.arrayContaining([expect.objectContaining({ landing: expect.objectContaining({ fields: expect.objectContaining({ 'Note Owner Email': 'priya@fund.com' }) }) })]),
    });
  });

  it('the module line is the one the platform loads', () => {
    expect(BUILTIN_MODULES.granola?.line).toBe('module');
  });

  it.each(RECORDINGS)('%s: the module in process, as the platform loads it, replays identically', async (_name, file, run) => {
    await expectParity(file, run, inProcessSubject);
  });

  it.each(RECORDINGS)('%s: the module served as a process, over protocol 2, replays identically', async (_name, file, run) => {
    const served = await serveGranola();
    try {
      await expectParity(file, run, async (baseUrl) => {
        const credentials = createMemoryVault({ 'cred-parity': { apiKey: API_KEY, baseUrl } });
        const config = { adapterType: 'granola', teamId: TEAM, baseUrl: served.url, authStrategy: { kind: 'bearer' as const }, credentialsId: 'cred-parity' };
        const remote = createRemoteAdapter({
          config,
          secret: '',
          cacheScopeId: 'parity',
          manifest: await fetchRemoteManifest(config, ''),
          documents: { put: async () => ({}) } as never,
          credential: { name: 'granola', secrets: createSecretsFamily({ backend: credentials }), ref: 'cred-parity' },
        });
        return { adapter: remote, poll: async (input) => readPollAnswer('granola', await remote.poll(input)) };
      }, { overProtocol: true });
    } finally {
      served.stop();
    }
  });
});

/** `serve-module @lf/granola` as a child process. */
async function serveGranola(): Promise<{ url: string; stop(): void }> {
  const child = spawn(process.execPath, [SERVE_MODULE, '.'], {
    cwd: packageDir('@listen-fire/granola'),
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
