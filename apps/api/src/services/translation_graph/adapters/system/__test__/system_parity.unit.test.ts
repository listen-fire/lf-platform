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

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { TranscriptEntry } from './parity/script';

import { PARITY_NOW, runSystemParityScript, worldReaders } from './parity/script';
import { SystemAdapter } from '../index';
import { SystemPollSource } from '../poll';

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

async function legacyRun(): Promise<Recording> {
  const questions: unknown[] = [];
  const readers = worldReaders(questions);
  const transcript = await runSystemParityScript({
    adapter: new SystemAdapter(TEAM),
    poll: new SystemPollSource(TEAM, readers.readFailedRuns as never, () => new Date(), readers.readStoredEvents as never),
  });
  return { transcript, questions };
}

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
});
