// The judge served as the judge slot's module, its model call made through a
// fake host models door: the slot's conformance kit, a judged question
// answered with the door's cost, and a judge with no door saying why it
// could not be asked.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JUDGE_METHODS, JudgeArbitrateAnswer } from 'engine-contracts/slots';
import { SlotClient, commonSlotCases, judgeSlotCases, serveSlot, type ServedSlot } from 'module-runtime/module-wire';

import { JUDGE_LLM_MANIFEST, hostDoorFromEnv, judgeLlmAnswer } from '../judge_slot';

interface FakeDoor {
  url: string;
  asked: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** A host's models door that judges every question "candidate 1, sure". */
async function fakeDoor(): Promise<FakeDoor> {
  const asked: FakeDoor['asked'] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      asked.push({ path: request.url ?? '/', authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const data = { match_index: 1, confidence: 0.9, reasoning: 'same domain' };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: JSON.stringify(data), data, cost: [{ label: 'gemini/gemini-3.8-flash', microdollars: 45 }], usage: { inputTokens: 10, outputTokens: 4 } }));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

// Two candidates the rules cannot tell apart: both match the name fuzzily.
const QUESTION = {
  asserted: { name: 'Acme', domain: 'acme.com' },
  candidates: [
    { adapterType: 'crm', recordType: 'Company', externalId: 'c1', data: { name: 'ACME Inc', domain: 'acme.io' } },
    { adapterType: 'crm', recordType: 'Company', externalId: 'c2', data: { name: 'Acme Ltd', domain: 'acme.com' } },
  ],
  recordType: 'Company',
  constraints: { any: [{ all: [{ field: 'name', fuzzy: true }] }] },
  languageVersion: 5,
};

let door: FakeDoor;
let served: ServedSlot;

beforeEach(async () => {
  door = await fakeDoor();
  served = await serveSlot({ manifest: JUDGE_LLM_MANIFEST, answer: judgeLlmAnswer(hostDoorFromEnv({ LF_HOST_URL: `${door.url}/`, LF_HOST_TOKEN: 'host-token' })) });
});

afterEach(async () => {
  await served.close();
  await door.close();
});

describe('the judge slot conformance kit', () => {
  for (const conformance of [...commonSlotCases('judge', JUDGE_METHODS), ...judgeSlotCases]) {
    it(conformance.name, async () => {
      await conformance.run(new SlotClient(served.address, {}));
    });
  }
});

it('asks the host’s models door, on the host’s token, and answers its pick with what the door charged', async () => {
  const answer = await new SlotClient(served.address, {}).read('judge.arbitrate', QUESTION, JudgeArbitrateAnswer);
  expect(answer).toEqual({ index: 1, cost: [{ label: 'gemini/gemini-3.8-flash', microdollars: 45 }] });
  expect(door.asked).toHaveLength(1);
  expect(door.asked[0]).toMatchObject({ path: '/api/public/adapter/judge_llm/models', authorization: 'Bearer host-token' });
  expect(door.asked[0]?.body).toMatchObject({ label: 'tg_entity_match', model: 'claude-sonnet-5', toolName: 'verdict' });
});

it('with no models door, declines and says why rather than reading as a considered decline', async () => {
  const lonely = await serveSlot({ manifest: JUDGE_LLM_MANIFEST, answer: judgeLlmAnswer(hostDoorFromEnv({})) });
  try {
    const answer = await new SlotClient(lonely.address, {}).read('judge.arbitrate', QUESTION, JudgeArbitrateAnswer);
    expect(answer.index).toBeNull();
    expect(answer.judgeUnavailable).toMatch(/no models door/);
  } finally {
    await lonely.close();
  }
});
