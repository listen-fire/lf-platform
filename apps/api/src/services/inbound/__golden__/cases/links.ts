// The capability-link doors: the link's own id or token is the authorisation.
// /api/asks/<token> answers asks.

import type { GoldenCase, RequestSpec } from '../harness';

import { world } from '../world';
import { define, json, post, text } from './support';

const FAR_FUTURE = new Date('2031-01-01T00:00:00Z');
const PAST = new Date('2020-01-01T00:00:00Z');
const get = (path: string, accept?: string): RequestSpec => ({
  method: 'GET',
  path,
  headers: accept === undefined ? {} : { accept },
  body: { kind: 'none' },
});

// ── asks ──────────────────────────────────────────────────────────────────

const askRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'ask-id-1',
  teamId: 'team-1',
  family: 'Choose',
  answerType: 'text',
  prompt: 'Which plan should we use?',
  detail: null,
  options: ['Basic', 'Pro'],
  rows: null,
  state: 'open',
  answer: null,
  token: 'ask_golden1',
  url: 'https://golden.example.test/api/asks/ask_golden1',
  tokenExpiresAt: FAR_FUTURE,
  provenance: {},
  callbackUrl: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  answeredAt: null,
  expiredAt: null,
  ...overrides,
});
const givenAsk = (overrides: Record<string, unknown> = {}) => {
  world.asks.ask_golden1 = askRecord(overrides);
};
const ASK = '/api/asks/ask_golden1';

export const askCases: GoldenCase[] = define('asks', [
  { id: 'get-detail-open', note: 'The JSON the web renderer fetches for an open ask.', arrange: () => givenAsk(), request: get(`${ASK}/detail`) },
  { id: 'get-detail-legacy-token', note: 'A token this store did not mint is closed: 410.', request: get('/api/asks/legacy-token/detail') },
  { id: 'get-detail-answered', note: 'An answered ask is 410 already_resolved.', arrange: () => givenAsk({ state: 'answered', answer: 'Pro' }), request: get(`${ASK}/detail`) },
  { id: 'get-detail-closed-request', note: 'A withdrawn ask is 410 (reported as expired).', arrange: () => givenAsk({ state: 'expired' }), request: get(`${ASK}/detail`) },
  { id: 'get-detail-link-lapsed', note: 'An open ask whose link lapsed is 410.', arrange: () => givenAsk({ tokenExpiresAt: PAST }), request: get(`${ASK}/detail`) },
  { id: 'get-page-choose', note: 'A Choose ask renders a button per option; the GET answers nothing.', arrange: () => givenAsk(), request: get(ASK) },
  { id: 'get-page-check', note: 'A Check ask renders Approve / Decline.', arrange: () => givenAsk({ family: 'Check', answerType: 'boolean', options: null }), request: get(ASK) },
  { id: 'get-page-provide', note: 'A Provide ask renders a typed input.', arrange: () => givenAsk({ family: 'Provide', answerType: 'text', options: null }), request: get(ASK) },
  { id: 'get-page-select', note: 'A Select ask renders a checklist.', arrange: () => givenAsk({ family: 'Select', options: ['x', 'y', 'z'] }), request: get(ASK) },
  { id: 'get-page-with-answer-param-confirms', note: 'A link carrying ?answer= renders a confirm step and never resolves (prefetch safety).', arrange: () => givenAsk(), request: get(`${ASK}?answer=Pro`) },
  { id: 'get-page-answered', note: 'An answered ask renders the recorded answer, 410.', arrange: () => givenAsk({ state: 'answered', answer: 'Pro' }), request: get(ASK) },
  { id: 'get-page-closed-request', note: 'A withdrawn ask renders the closed page, 410.', arrange: () => givenAsk({ state: 'expired' }), request: get(ASK) },
  { id: 'get-page-link-lapsed', note: 'A lapsed link renders the expired page, 410.', arrange: () => givenAsk({ tokenExpiresAt: PAST }), request: get(ASK) },
  { id: 'get-page-legacy-token', note: 'A legacy token renders the closed page, 410.', request: get('/api/asks/legacy-token') },
  { id: 'post-without-answer', note: 'A POST with no answer anywhere is 400.', arrange: () => givenAsk(), request: post(ASK, json({})) },
  {
    id: 'post-answer-json',
    note: 'A JSON answer goes through the one answer door and renders the confirmation, 200.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'answered', ask: askRecord({ state: 'answered', answer: 'Pro' }) });
    },
    request: post(ASK, json({ answer: 'Pro' })),
  },
  {
    id: 'post-answer-form',
    note: 'The page forms post urlencoded.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'answered', ask: askRecord({ state: 'answered', answer: 'Basic' }) });
    },
    request: post(ASK, { kind: 'form', fields: { answer: 'Basic' } }, { 'content-type': 'application/x-www-form-urlencoded' }),
  },
  {
    id: 'post-answer-in-query',
    note: 'The confirm form may carry the answer in the query string.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'answered', ask: askRecord({ state: 'answered', answer: 'Pro' }) });
    },
    request: post(`${ASK}?answer=Pro`, text('')),
  },
  {
    id: 'post-answer-invalid',
    note: 'A value that does not fit is 400 with the reason.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'invalid', message: 'not one of the offered options', ask: askRecord() });
    },
    request: post(ASK, json({ answer: 'Platinum' })),
  },
  {
    id: 'post-answer-lost-the-race',
    note: 'An ask settled between lookup and write renders its terminal page, closed-request-wins.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'closed', ask: askRecord({ state: 'answered', answer: 'Basic' }) });
    },
    request: post(ASK, json({ answer: 'Pro' })),
  },
  { id: 'post-already-answered', note: 'A POST to an answered ask is its terminal page, 410, and never reaches the answer door.', arrange: () => givenAsk({ state: 'answered', answer: 'Pro' }), request: post(ASK, json({ answer: 'Basic' })) },
  { id: 'post-legacy-token', note: 'A legacy token is closed: 410.', request: post('/api/asks/legacy-token', json({ answer: 'x' })) },
]);
