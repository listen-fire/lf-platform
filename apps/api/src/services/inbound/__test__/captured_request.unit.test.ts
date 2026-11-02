import type { Arrival } from 'engine-contracts';

import { capturedRequest, keptPage, readKeptRequest } from '../captured_request';

const arrival: Arrival = {
  edge: 'Messages',
  key: 'C1',
  identity: 'C1:1.0',
  landing: { recordId: 'C1:1.0', recordType: 'Slack Message', fields: { Message: 'hi' } },
};

const decoded = (body: string): string => Buffer.from(body, 'base64').toString('utf8');

describe('a kept request', () => {
  it("drops a JSON body's own members its module redacts, keeps the rest as sent", () => {
    const kept = capturedRequest({
      keeping: { redactFields: ['token'] },
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(JSON.stringify({ token: 'legacy', event: { token: 'inner stays', text: 'hi' } })),
      arrivals: [arrival],
    });
    expect(JSON.parse(decoded(kept.body))).toEqual({ event: { token: 'inner stays', text: 'hi' } });
    expect(kept.arrivalIds).toHaveLength(1);
  });

  it("keeps a body with nothing to redact byte for byte", () => {
    const raw = '{ "text":  "spacing kept" }';
    const kept = capturedRequest({ keeping: { redactFields: ['token'] }, headers: {}, rawBody: Buffer.from(raw), arrivals: [] });
    expect(decoded(kept.body)).toBe(raw);
  });

  it("drops a form's fields and the members of a JSON object a field holds", () => {
    const payload = JSON.stringify({ token: 'legacy', type: 'block_actions' });
    const kept = capturedRequest({
      keeping: { redactFields: ['token'] },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      rawBody: Buffer.from(new URLSearchParams({ payload, token: 'top' }).toString()),
      arrivals: [],
    });
    const form = new URLSearchParams(decoded(kept.body));
    expect(form.has('token')).toBe(false);
    expect(JSON.parse(form.get('payload') ?? '')).toEqual({ type: 'block_actions' });
  });

  it('drops the redacted query parameters', () => {
    const kept = capturedRequest({ keeping: { redactFields: ['key'] }, query: 'key=s3cret&page=2', headers: {}, rawBody: Buffer.from(''), arrivals: [] });
    expect(kept.query).toBe('page=2');
  });

  it('keeps only the headers its module reads, never one that may carry a credential nor the signature', () => {
    const kept = capturedRequest({
      keeping: { captureHeaders: ['svix-id', 'x-api-key'] },
      headers: { 'svix-id': 'msg_1', 'x-api-key': 'k', 'x-slack-signature': 'v0=abc', authorization: 'Bearer t', 'content-type': 'application/json' },
      rawBody: Buffer.from('{}'),
      arrivals: [],
    });
    expect(kept.headers).toEqual({ 'svix-id': 'msg_1', 'content-type': 'application/json' });
  });

  it('reads back as a request, and a poll page as a page', () => {
    const request = capturedRequest({ keeping: undefined, headers: {}, rawBody: Buffer.from('{}'), checkpoint: { cursor: 3 }, arrivals: [arrival] });
    expect(readKeptRequest(JSON.parse(JSON.stringify(request)))).toEqual({ request });
    const page = keptPage({ adapterType: 'gmail', credentialsId: 'cred-1', arrivals: [arrival] });
    expect(readKeptRequest(JSON.parse(JSON.stringify(page)))).toEqual({ page });
    expect(readKeptRequest(null)).toBeNull();
  });
});
