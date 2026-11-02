/**
 * Unit tests for the Slack WebhookProvider (I1).
 *
 * Covers the surface the I1 brief requires:
 *
 *   1. `parseEvents` on the wave-1 golden-path fixture produces exactly
 *      one normalised `WebhookEvent` whose `rawPayload` is the inner Slack
 *      event.
 *   2. `parseEvents` returns [] for `url_verification` and unknown
 *      envelope types — those aren't dispatchable events.
 *   3. `verifySignature` accepts a payload signed with the documented
 *      Slack scheme (`v0=` + HMAC-SHA256(secret, `v0:{ts}:{rawBody}`))
 *      and rejects tampered ones.
 *   4. The provider is registered under the 'SLACK' key.
 *
 * Deliberately doesn't bring up the full `handleInboundWebhook` path —
 * that would require a DB.
 */

import crypto from "node:crypto";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


import { slackProvider, parseSlackEvents } from '../providers/slack';
import { verifyAsProvider } from '../../inbound/__test__/verify_as_provider';
// Avoid importing '../providers' (the aggregate index) because it pulls in
// the attio provider at module load, which requires ENCRYPTION_MASTER_KEY
// at import time. We verify the registration structurally instead by
// reading the source — see "registered under the SLACK key" below.

const FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  'translation_graph',
  '__fixtures__',
  'wave-1-golden-path',
  'synthetic-slack-message.json',
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
}

function fixtureRawBody(): Buffer {
  // Deterministic body — exactly what would arrive over the wire. Used
  // for HMAC tests so the signature math is reproducible.
  return Buffer.from(readFileSync(FIXTURE_PATH, 'utf-8'), 'utf-8');
}

describe('slackProvider — registration', () => {
  it('is registered under the SLACK provider key', () => {
    // Structural check (avoids importing the aggregate provider registry,
    // which transitively loads attio.ts → lib/credentials.ts → demands
    // ENCRYPTION_MASTER_KEY at unit-test time). The contract we care about
    // is that webhook_sync/providers/index.ts maps the literal 'SLACK' to
    // the slackProvider — grep the source for that pairing.
    const src = readFileSync(
      join(__dirname, '..', 'providers', 'index.ts'),
      'utf-8',
    );
    expect(src).toMatch(/SLACK:\s*slackProvider/);
  });

  it('is manual-mode (canRegisterViaApi=false) with operator setup instructions', () => {
    expect(slackProvider.canRegisterViaApi).toBe(false);
    expect(slackProvider.setupInstructions).toBeTruthy();
    expect(slackProvider.setupInstructions).toMatch(/Signing Secret/);
  });

  it('exposes the slack default event types', () => {
    expect(slackProvider.defaultEventTypes).toContain('message');
  });
});

describe('slackProvider.parseEvents — golden-path fixture', () => {
  it('produces exactly one WebhookEvent from the synthetic slack message fixture', () => {
    const events = parseSlackEvents(loadFixture());
    expect(events).toHaveLength(1);
  });

  it('normalises Slack record/event ids into the framework shape', () => {
    const [event] = parseSlackEvents(loadFixture());
    expect(event.eventType).toBe('message');
    expect(event.recordId).toBe('1747836000.000100');
    expect(event.objectId).toBe('slack:message');
    expect(event.actor).toBeUndefined();
    expect(event.changedFields).toBeUndefined();
  });

  it('forwards the inner event as rawPayload (not the envelope)', () => {
    const [event] = parseSlackEvents(loadFixture());
    expect(event.rawPayload).toMatchObject({
      type: 'message',
      user: 'U_ALICE',
      channel: 'C_DEALFLOW',
      ts: '1747836000.000100',
      text: expect.stringContaining('Acme AI'),
      files: expect.any(Array),
    });
  });
});

describe('slackProvider.parseEvents — non-dispatchable envelopes', () => {
  it('returns [] for url_verification (handled by the REST layer)', () => {
    const events = parseSlackEvents({
      type: 'url_verification',
      challenge: 'abc-123',
    });
    expect(events).toEqual([]);
  });

  it('returns [] for app_rate_limited', () => {
    const events = parseSlackEvents({
      type: 'app_rate_limited',
      api_app_id: 'A123',
    });
    expect(events).toEqual([]);
  });

  it('returns [] for malformed payloads', () => {
    expect(parseSlackEvents({})).toEqual([]);
    expect(parseSlackEvents(null)).toEqual([]);
    expect(parseSlackEvents('not-an-object')).toEqual([]);
  });

  it('returns [] for event_callback without an event field', () => {
    expect(
      parseSlackEvents({ type: 'event_callback', team_id: 'T1' }),
    ).toEqual([]);
  });
});

describe('Slack v0 HMAC scheme', () => {
  const SECRET = 'slack-signing-secret';
  // The core's verifier refuses a timestamp outside Slack's five-minute replay
  // window, so each case signs on the test's own clock.
  const nowSeconds = (): string => String(Math.floor(Date.now() / 1000));

  function signWith(rawBody: Buffer, secret: string, timestamp: string): string {
    const base = `v0:${timestamp}:${rawBody.toString('utf-8')}`;
    const digest = crypto.createHmac('sha256', secret).update(base).digest('hex');
    return `${timestamp}:v0=${digest}`;
  }

  it('accepts a correctly signed request', () => {
    const rawBody = fixtureRawBody();
    const ts = nowSeconds();
    const header = signWith(rawBody, SECRET, ts);
    expect(verifyAsProvider('SLACK', rawBody, header, SECRET)).toBe(true);
  });

  it('accepts a signature without the `v0=` prefix (raw hex)', () => {
    const rawBody = fixtureRawBody();
    const ts = nowSeconds();
    const base = `v0:${ts}:${rawBody.toString('utf-8')}`;
    const digest = crypto.createHmac('sha256', SECRET).update(base).digest('hex');
    const header = `${ts}:${digest}`;
    expect(verifyAsProvider('SLACK', rawBody, header, SECRET)).toBe(true);
  });

  it('rejects when the body has been tampered with', () => {
    const ts = nowSeconds();
    const header = signWith(fixtureRawBody(), SECRET, ts);
    const tampered = Buffer.from(fixtureRawBody().toString('utf-8') + ' '); // extra byte
    expect(verifyAsProvider('SLACK', tampered, header, SECRET)).toBe(false);
  });

  it('rejects when the secret is wrong', () => {
    const rawBody = fixtureRawBody();
    const ts = nowSeconds();
    const header = signWith(rawBody, SECRET, ts);
    expect(verifyAsProvider('SLACK', rawBody, header, 'wrong-secret')).toBe(false);
  });

  it('rejects a delivery signed more than five minutes ago', () => {
    const rawBody = fixtureRawBody();
    const header = signWith(rawBody, SECRET, String(Number(nowSeconds()) - 6 * 60));
    expect(verifyAsProvider('SLACK', rawBody, header, SECRET)).toBe(false);
  });

  it('rejects when the timestamp is missing from the packed header', () => {
    const rawBody = fixtureRawBody();
    expect(verifyAsProvider('SLACK', rawBody, '', SECRET)).toBe(false);
    expect(verifyAsProvider('SLACK', rawBody, ':v0=deadbeef', SECRET)).toBe(false);
  });
});
