// Recorded parity for Listen-Fire Valuations. The fixture is the legacy
// adapter as it was before Valuations became a module, driven through
// `native_valuations_parity/script.ts` against a deterministic fake of the
// Valuations REST API (there is none in fake-channels): every answer, and
// every request it made with what came back. Each implementation is replayed
// against the recording and must make the same requests and give the same
// answers.
//
// The stored credential names no base URL, as the platform's own provisioned
// one does: the platform's address (API_BASE_URL) is where the API is.
//
// Re-record (only when the legacy line changes on purpose, reading the diff):
// NATIVE_VALUATIONS_PARITY_RECORD=1 pnpm test:unit --testPathPattern native_valuations_parity

jest.mock('../../../../lib/credentials', () => ({
  decryptToken: async () => (await import('./crm_parity/legacy_row')).decryptSeededRow(),
  encryptToken: async () => '',
}));
jest.mock('../../../../lib/kysely', () => ({
  getAutomationsQb: () => jest.requireActual<typeof import('./crm_parity/legacy_row')>('./crm_parity/legacy_row').rowQueryBuilder(),
}));

// The platform's encrypted store, as a vault the test seeds: the module line
// reads its credential through the secrets family exactly as in production.
const vault: { current?: ReturnType<typeof import('movement-engine/public/secrets').createMemoryVault> } = {};
jest.mock('../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../credentials/secrets_postgres'),
  postgresSecrets: () => {
    if (vault.current === undefined) throw new Error('no vault seeded');
    return vault.current;
  },
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Adapter } from 'movement-engine/public/adapter';

import { createMemoryVault } from 'movement-engine/public/secrets';
import { createNativeValuationsAdapter } from '../native_valuations';
import { getAdapter } from '../registry';
import { BUILTIN_MODULES } from '../builtin_modules';
import { recordingServer, replayingServer, type Exchange, type ExchangeRequest } from './parity/exchange';
import { legacyRow } from './crm_parity/legacy_row';
import { freezeClock, type TranscriptEntry } from './crm_parity/walk';
import { FAKE_VALUATIONS_API_KEY, bootFakeValuations } from './native_valuations_parity/fake_valuations';
import { runValuationsParityScript, runValuationsWithoutCredentialScript } from './native_valuations_parity/script';

const FIXTURE = join(__dirname, '__fixtures__/native_valuations_parity.json');
/** The stored payload the platform provisions: a key and its id, no base URL. */
const STORED = { apiKey: FAKE_VALUATIONS_API_KEY, apiKeyId: '0b6a3c1e-8f7d-4c2a-9e51-3d2f4a6b7c80' };

interface Recording {
  transcript: TranscriptEntry[];
  withoutCredential: TranscriptEntry[];
  exchanges: Exchange[];
}

/** The webhook secret a registration mints is random: parity holds that one
 *  was sent, not its value. */
function normalize(request: ExchangeRequest): ExchangeRequest {
  const body = request.body;
  if (body === null || typeof body !== 'object' || !('secret' in body)) return request;
  const { secret } = body as { secret: unknown };
  return { ...request, body: { ...body, secret: typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret) ? '<64 hex>' : secret } };
}

let subjects = 0;
function freshInstall(): { teamId: TeamId; credentialsId: string } {
  subjects += 1;
  return { teamId: `team-parity-${subjects}` as TeamId, credentialsId: `cred-parity-${subjects}` };
}

/** The legacy line, its credential row read and decrypted as in production. */
function legacySubject(): Adapter {
  const install = freshInstall();
  legacyRow.payload = { ...STORED };
  legacyRow.id = install.credentialsId;
  return createNativeValuationsAdapter(install);
}

const legacyWithoutCredential = (): Adapter => createNativeValuationsAdapter({ teamId: freshInstall().teamId });

/** The module line, as the registry hosts it, over the stored credential. */
function moduleSubject(): Adapter {
  const install = freshInstall();
  vault.current = createMemoryVault({ [install.credentialsId]: { ...STORED } });
  return getAdapter({ adapterType: 'native-valuations', ...install });
}

const moduleWithoutCredential = (): Adapter => getAdapter({ adapterType: 'native-valuations', teamId: freshInstall().teamId });

jest.setTimeout(120_000);
beforeAll(freezeClock);
afterAll(() => jest.useRealTimers());

const savedApiBaseUrl = process.env.API_BASE_URL;
afterEach(() => {
  if (savedApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = savedApiBaseUrl;
});

const recording = process.env.NATIVE_VALUATIONS_PARITY_RECORD === '1';

(recording ? it : it.skip)('records the legacy adapter against the fake Valuations API', async () => {
  const fake = await bootFakeValuations();
  const proxy = await recordingServer(fake.baseUrl, { normalize });
  try {
    process.env.API_BASE_URL = proxy.baseUrl;
    const transcript = await runValuationsParityScript(legacySubject());
    const withoutCredential = await runValuationsWithoutCredentialScript(legacyWithoutCredential());
    const fixture: Recording = { transcript, withoutCredential, exchanges: proxy.exchanges() };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await proxy.close();
    await fake.stop();
  }
});

function loadRecording(): Recording {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recording;
}

/** Replay against the recording: same answers, same requests. */
async function expectValuationsParity(subject: () => Promise<Adapter> | Adapter, withoutCredential: () => Promise<Adapter> | Adapter): Promise<void> {
  const recorded = loadRecording();
  const server = await replayingServer(recorded.exchanges, { normalize });
  try {
    process.env.API_BASE_URL = server.baseUrl;
    expect(await runValuationsParityScript(await subject())).toEqual(recorded.transcript);
    expect(await runValuationsWithoutCredentialScript(await withoutCredential())).toEqual(recorded.withoutCredential);
    const recordedRequests = recorded.exchanges.map(({ status: _s, response: _r, ...request }) => request);
    expect(server.requests()).toEqual(recordedRequests);
  } finally {
    await server.close();
  }
}

(recording ? describe.skip : describe)('native-valuations recorded parity', () => {
  it('the recording walks the surface, computes, writes and subscribes', () => {
    const { transcript, exchanges } = loadRecording();
    const answered = (step: string) => transcript.find((entry) => entry.step === step)?.answer;
    const failed = (step: string) => {
      const answer = answered(step);
      return answer !== null && typeof answer === 'object' && 'error' in answer;
    };
    // The refusals the script asks for on purpose, and nothing else.
    const errors = transcript.filter((entry) => failed(entry.step)).map((entry) => entry.step);
    expect(errors).toEqual([
      'resolveEntity FUZZY on a field that does not take it',
      'createRecord Event along the wrong edge',
      'createRecord AddInvestment without its investor',
      'iterateRelated root Investment (reached through its parents)',
    ]);
    expect(answered('Legal Entity -[Valuations WHERE date AND currency]->')).toHaveLength(1);
    expect(answered('ensureEventSubscription create')).toEqual({
      externalId: 'https://example.test/api/public/webhook-sync/native_valuations/sub-1',
      secret: '<64 hex>',
    });
    const paths = exchanges.map((exchange) => `${exchange.method} ${exchange.path.split('?')[0]}`);
    for (const expected of [
      'GET /api/v1/valuations/events',
      'POST /api/v1/valuations/compute',
      'POST /api/v1/valuations/commands/add-markdown',
      'POST /api/v1/valuations/commands/add-investment',
      'PATCH /api/v1/valuations/legal-entities/legal-entities-new-1',
      'DELETE /api/v1/valuations/legal-entities/legal-entities-new-1',
      'POST /api/v1/valuations/webhooks',
      'DELETE /api/v1/valuations/webhooks',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it('the legacy line replays identically', async () => {
    await expectValuationsParity(legacySubject, legacyWithoutCredential);
  });

  it('the module in process, through the platform registry, replays identically', async () => {
    expect(BUILTIN_MODULES['native-valuations']?.line).toBe('module');
    await expectValuationsParity(moduleSubject, moduleWithoutCredential);
  });
});
