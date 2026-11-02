// The Slack interactivity door, end to end through the route: a signed
// block_actions POST in, the tap recorded and its reply queued as a
// `slack_response` row before the answer, and the reply posted at the
// payload's `response_url` when that row drains.
//
// Three claims carry it:
//   0. Nothing runs after the answer: Slack hears 200 only once the reply row
//      is written, and the post to Slack happens in the drain, not the request.
//   1. The ask door's outcome is what the tapper is told — every refusal is
//      SAID, never swallowed into a silent 200.
//   2. The message is edited only when the tap answered the ask; a refusal
//      never rewrites what the first tapper is looking at.
//
// The ask door is mocked — what is under test is the door.

import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';

const answerAskByToken = jest.fn();

jest.mock('../../../services/asks/doors', () => ({
  answerAskByToken: (...args: unknown[]) => answerAskByToken(...args),
}));
/** The rows the door queued, in order: what the drain would run. */
let queued: { kind: string; key: string; payload: unknown }[] = [];
let holdEnqueue: Promise<void> | undefined;
let enqueueReached: (() => void) | undefined;
jest.mock('../../../services/work/store', () => ({
  enqueueWork: async (row: { kind: string; key: string; payload: unknown }) => {
    enqueueReached?.();
    await holdEnqueue;
    queued.push(row);
  },
}));
jest.mock('../../../services/work/drain', () => ({
  ...jest.requireActual('../../../services/work/drain'),
  notifyWork: () => {},
}));
// The signature is Slack's business, not this door's — verified by
// slackEvents' own suite.
jest.mock('../slackEvents', () => ({
  verifySlackEventsRequest: () => ({ authorized: true }),
}));

import { slackInteractivityRouter } from '../slackInteractivity';
import { slackResponseHandler } from '../../../services/webhook_sync/slack_response_url';

let server: Server;
let baseUrl: string;

const ANSWER_YES = { type: 'button', action_id: 'ask_answer_0', value: 'http://localhost:3500/api/asks/ask_abc?answer=true' };

/** Every POST the door made to the payload's response_url, in order. */
let acks: Record<string, unknown>[] = [];
const RESPONSE_URL = 'https://hooks.slack.example/response/1';

beforeAll((done) => {
  const app = express();
  app.use('/api/public/slack-actions', express.raw({ type: '*/*' }), slackInteractivityRouter as Router);
  server = createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

/** The real one — the test's own POSTs at the loopback server must still go
 *  out; only the response_url ack is intercepted. */
const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  acks = [];
  queued = [];
  holdEnqueue = undefined;
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) !== RESPONSE_URL) return await realFetch(url, init);
    acks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('ok');
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function post(action: Record<string, unknown>): Promise<Response> {
  const payload = {
    type: 'block_actions',
    response_url: RESPONSE_URL,
    trigger_id: 'trig-1',
    actions: [action],
  };
  return fetch(`${baseUrl}/api/public/slack-actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
  });
}

/** POST one block action, then run the rows it queued as the drain would. */
async function tap(action: Record<string, unknown>): Promise<void> {
  const res = await post(action);
  expect(res.status).toBe(200);
  expect(acks).toHaveLength(0);
  for (const row of queued) {
    expect(row.kind).toBe('slack_response');
    await slackResponseHandler.run(row.payload, { now: new Date(), owner: 'test', attempts: 1, heartbeat: async () => {} });
  }
}

describe('nothing runs after the answer', () => {
  it('answers only once the reply row is written, and posts nothing in the request', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: { id: 'ask-1' } });
    let release: () => void = () => {};
    holdEnqueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Wait for the door to reach the write, not for a fixed time: under a
    // loaded machine the request can take longer than any sleep.
    const reached = new Promise<void>((resolve) => {
      enqueueReached = resolve;
    });
    let answered = false;
    const response = post(ANSWER_YES).then((res) => {
      answered = true;
      return res;
    });
    await reached;
    expect(answerAskByToken).toHaveBeenCalledTimes(1);
    expect(answered).toBe(false);

    release();
    expect((await response).status).toBe(200);
    expect(queued).toEqual([
      { kind: 'slack_response', key: 'slack_response:trig-1', payload: expect.objectContaining({ responseUrl: RESPONSE_URL }) },
    ]);
    expect(acks).toHaveLength(0);
  });

  it('keys the reply on the interaction, so a second delivery of it folds onto one row', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: { id: 'ask-1' } });
    await post(ANSWER_YES);
    await post(ANSWER_YES);
    expect(new Set(queued.map((row) => row.key))).toEqual(new Set(['slack_response:trig-1']));
  });
});

describe('a tap that answers an ask', () => {
  it('answers through the ask door and replaces the message', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: { id: 'ask-1' } });

    await tap(ANSWER_YES);

    expect(answerAskByToken).toHaveBeenCalledWith('ask_abc', 'true');
    expect(acks[0]).toMatchObject({
      replace_original: true,
      text: 'Thanks — your answer was recorded.',
    });
  });

  it('passes a datepicker`s pick as the answer of a bare ask token', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'answered', ask: { id: 'ask-1' } });

    await tap({ type: 'datepicker', action_id: 'ask_date', selected_date: '2026-08-15' });

    expect(answerAskByToken).toHaveBeenCalledWith('ask_date', '2026-08-15');
  });

  it('tells the tapper something went wrong when answering throws, rather than nothing', async () => {
    answerAskByToken.mockRejectedValue(new Error('asks table unreachable'));

    await tap(ANSWER_YES);

    expect(acks).toEqual([
      { response_type: 'ephemeral', replace_original: false, text: 'Something went wrong recording that.' },
    ]);
  });
});

describe('every refusal is said, and none of them touches the message', () => {
  it('a callback button an automation wired before 0.13 → an ephemeral notice that it was retired', async () => {
    await tap({ type: 'button', action_id: 'cb_abc', value: 'cb_abc' });

    expect(answerAskByToken).not.toHaveBeenCalled();
    expect(acks[0]).toEqual({ response_type: 'ephemeral', replace_original: false, text: expect.stringContaining('upgrade the automation') });
  });

  it('a closed ask → an ephemeral notice', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'closed' });

    await tap(ANSWER_YES);

    expect(acks[0]).toEqual({ response_type: 'ephemeral', replace_original: false, text: 'This request was already closed.' });
  });

  it('an invalid answer says exactly what was wrong', async () => {
    answerAskByToken.mockResolvedValue({ kind: 'invalid', message: 'answer must be yes or no' });

    await tap(ANSWER_YES);

    expect(acks[0]).toEqual({
      response_type: 'ephemeral',
      replace_original: false,
      text: 'That answer could not be accepted: answer must be yes or no',
    });
  });

  it('an ordinary block action answers nothing and queues nothing', async () => {
    await tap({ type: 'button', action_id: 'open_expense_42', value: 'expense_42' });

    expect(answerAskByToken).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
    expect(acks).toHaveLength(0);
  });
});
