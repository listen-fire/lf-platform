// Recorded parity for `system`. The fixture is the legacy adapter and poll
// source as they were before `system` became a module, driven through
// `parity/script.ts` over a fixed world of failed runs and stored platform
// events: every answer, and every question the poll asked the platform's
// readers. Each implementation is replayed and must ask the same questions
// and give the same answers.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// SYSTEM_PARITY_RECORD=1 pnpm test:unit --testPathPattern system_parity

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('../../../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));

/** Where the platform's readers log the questions they are asked. */
const questions: unknown[] = [];

// The platform's records, as the module line and the legacy line read them:
// the world, asked in the recording's terms (a team id, not a tenant).
jest.mock('../events', () => {
  const { worldReaders } = jest.requireActual('./parity/script');
  const readers = worldReaders(questions);
  return {
    ...jest.requireActual('../events'),
    platformSystemRecords: {
      failedRuns: ({ tenant, ...rest }: { tenant: string }) => readers.readFailedRuns({ teamId: tenant, ...rest }),
      storedEvents: ({ tenant, ...rest }: { tenant: string }) => readers.readStoredEvents({ teamId: tenant, ...rest }),
      webBaseUrl: () => 'http://localhost:3003',
    },
  };
});

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TranscriptEntry } from './parity/script';

import { PARITY_NOW, runSystemParityScript } from './parity/script';
import { createSystemAdapter, createSystemPollSource } from '../index';
import { getAdapter, getPollSource } from '../../registry';
import { BUILTIN_MODULES } from '../../builtin_modules';

const FIXTURE = join(__dirname, '__fixtures__/system_parity.json');
const TEAM = 'team-parity' as TeamId;

interface Recording {
  transcript: TranscriptEntry[];
  questions: unknown[];
}

const recording = process.env.SYSTEM_PARITY_RECORD === '1';

beforeEach(() => {
  jest.useFakeTimers({ now: PARITY_NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => {
  jest.useRealTimers();
});

/** One run of the script, with the questions it asked. */
async function run(subject: () => Parameters<typeof runSystemParityScript>[0]): Promise<Recording> {
  questions.length = 0;
  const transcript = await runSystemParityScript(subject());
  return { transcript, questions: [...questions] };
}

/** The legacy line, as the registry constructed it. */
const legacyRun = () =>
  run(() => ({ adapter: createSystemAdapter({ teamId: TEAM }), poll: createSystemPollSource({ teamId: TEAM }) }));

(recording ? it : it.skip)('records the legacy adapter and poll source', async () => {
  writeFileSync(FIXTURE, `${JSON.stringify(await legacyRun(), null, 2)}\n`);
});

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

(recording ? describe.skip : describe)('system recorded parity', () => {
  it('the recording delivers every kind and skips the listener’s own runs', () => {
    const { transcript } = loadRecording();
    const all = transcript.find((entry) => entry.step === 'poll all kinds from mark')?.answer as { events: Array<{ externalId: string }> };
    expect(all.events.map((event) => event.externalId)).toEqual(['run-a', 'e-1', 'e-3', 'e-4']);
  });

  it('the legacy line replays identically', async () => {
    expect(await legacyRun()).toEqual(loadRecording());
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES.system?.line).toBe('module');
    const replayed = await run(() => {
      const poll = getPollSource({ adapterType: 'system', teamId: TEAM });
      if (poll === null) throw new Error('system has no poll source');
      return { adapter: getAdapter({ adapterType: 'system', teamId: TEAM }), poll };
    });
    expect(replayed).toEqual(loadRecording());
  });
});
