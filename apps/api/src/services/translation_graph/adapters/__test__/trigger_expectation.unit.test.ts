// The agent grounds "what a listener fires on" in each adapter's manifest
// `triggerExpectation` (surfaced via listCatalog and describeInstance). The
// motivating bug: the agent told a user a Slack listener runs on "every
// message in any channel" when Slack only delivers the bot's subscribed
// events. These lock the honest prose in place so it can't quietly regress
// to over-claiming — and, registry-wide, so no source adapter ships without
// one.

import { SLACK_MANIFEST } from '../slack';
import { EMAIL_MANIFEST } from '../email';
import { ATTIO_MANIFEST } from '../attio';
import { AIRTABLE_MANIFEST } from '../airtable';
import { kgManifest } from '@listen-fire/kg/manifest';
import { WHATSAPP_MANIFEST } from '../whatsapp';
import { CRON_MANIFEST } from '../cron';
import { MANUAL_MANIFEST } from '../manual';
import { NATIVE_VALUATIONS_MANIFEST } from '../native_valuations';
import { listAdapterManifests } from '../registry';

const KG_MANIFEST = kgManifest({ changeWebhooks: false });

describe('adapter triggerExpectation — honest inbound semantics', () => {
  it('Slack spells out the scope and warns against "every message"', () => {
    const t = SLACK_MANIFEST.triggerExpectation;
    expect(t).toBeDefined();
    // It must NOT promise blanket capture; it must point at the real gate
    // (the bot's subscribed events / mentions) and tell the agent to confirm.
    expect(t).toMatch(/subscrib|mention/i);
    expect(t).toMatch(/not|don't|confirm|ask/i);
    expect(t).toMatch(/every message/i); // names the wrong claim to avoid
  });

  it('Email says mail must be sent to the address, not read from an inbox', () => {
    const t = EMAIL_MANIFEST.triggerExpectation;
    expect(t).toBeDefined();
    expect(t).toMatch(/address|forward|sent/i);
    expect(t).toMatch(/not|inbox/i);
  });

  it('Attio scopes to record events and warns off field-level promises', () => {
    const t = ATTIO_MANIFEST.triggerExpectation;
    expect(t).toBeDefined();
    expect(t).toMatch(/record\.created/);
    expect(t).toMatch(/does not fire on notes/i); // names the non-events
    expect(t).toMatch(/field-level|which field/i); // the over-claim to avoid
  });

  it('Airtable states one-table scope and notify-then-pull batching', () => {
    const t = AIRTABLE_MANIFEST.triggerExpectation;
    expect(t).toBeDefined();
    expect(t).toMatch(/ONE .*table/);
    expect(t).toMatch(/batch|coalesc/i);
    expect(t).toMatch(/do not promise/i);
  });

  it('KG warns about movement-written mutations looping', () => {
    const t = KG_MANIFEST.triggerExpectation;
    expect(t).toBeDefined();
    expect(t).toMatch(/another movement/i);
    expect(t).toMatch(/loop/i);
    expect(t).toMatch(/suppress_self/);
  });

  it('WhatsApp frames the number as a deliberate capture channel, never chat access', () => {
    const t = WHATSAPP_MANIFEST.triggerExpectation;
    expect(t).toBeDefined();
    expect(t).toMatch(/never reads/i);
    // On the shared number only the user's own linked phone reaches their
    // movements (not passive chat access): the copy frames it first-person.
    expect(t).toMatch(/only messages the user sends from their own linked number/i);
    expect(t).toMatch(/first-person/i);
  });

  it('cron and manual disclaim any reactive capture', () => {
    expect(CRON_MANIFEST.triggerExpectation).toMatch(/never as reacting/i);
    expect(MANUAL_MANIFEST.triggerExpectation).toMatch(/nothing fires on its own/i);
  });

  it('Affinity states the 3-subscription cap and disclaims unmapped kinds', () => {
    const { AFFINITY_MANIFEST } = jest.requireActual('../affinity');
    const t = AFFINITY_MANIFEST.triggerExpectation;
    expect(t).toBeDefined();
    expect(t).toMatch(/3 webhook subscriptions/i);
    expect(t).toMatch(/field_value|field-value/i);
    expect(t).toMatch(/do not promise/i);
  });

  it('Valuations names the required events narrowing', () => {
    expect(NATIVE_VALUATIONS_MANIFEST.triggerExpectation).toMatch(/MUST name the events/);
  });

  it('EVERY source adapter carries a triggerExpectation (no silent gaps)', () => {
    // An adapter that declares inbound triggers but no expectation leaves the
    // agent inventing trigger-surface claims — the class of gap this file
    // exists to prevent. Registry-wide so a new source can't ship without one.
    const sources = listAdapterManifests().filter((m) => m.supportedTriggers.length > 0);
    const missing = sources
      .filter((m) => !m.triggerExpectation || m.triggerExpectation.trim() === '')
      .map((m) => m.adapterType);
    expect(missing).toEqual([]);
  });
});
