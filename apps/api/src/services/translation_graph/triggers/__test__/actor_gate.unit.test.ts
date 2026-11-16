// Ownership gating for inbound events (message-write-unification §6.4b):
// for a pin from before its module's listens stopped being limited (Slack's
// `listensLimitedBefore`, 0.16.0), an inbound event is processed only when
// its actor resolves to a REGISTERED team user. The bot is never a registered user,
// so self-echo drops for free; an unregistered human drops by the same
// rule. The resolver is called WITHOUT trigger context — creator
// override / fallbackToCreatorIfActorUnregistered must not pass the gate.

import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ActingUser, ActorCandidate } from '../../adapters/acting_user/actor';

import { consultActorGate, inboundActorGateEnabled, type ActorSource } from '../actor_gate';

const TEAM_ID = 'team-1' as TeamId;
const PIN = '0.15.3';

const event = (adapterType: string): TriggerEvent => ({
  pipelineInputId: 'trigger:t1',
  adapterType,
  triggerType: 'webhook',
  payload: { type: 'message', user: 'U123' },
  occurredAt: new Date().toISOString(),
});

const adapterWith = (candidates: ActorCandidate[]): ActorSource => ({ adapterType: 'slack', getActorCandidates: async () => candidates });

const registered: ActingUser = { id: 'u-1', email: 'ada@example.com', name: 'Ada' };

describe('inboundActorGateEnabled — the manifest fact', () => {
  it('is on for slack below 0.16 and off for attio (pins the real manifests)', () => {
    expect(inboundActorGateEnabled('slack', PIN)).toBe(true);
    expect(inboundActorGateEnabled('attio', PIN)).toBe(false);
  });

  it('a pin that is no release is gated (fail closed)', () => {
    expect(inboundActorGateEnabled('slack', '4')).toBe(true);
  });
});

describe('the gate runs only below 0.16', () => {
  it.each(['0.16.0', '0.16.3', '0.17.0'])('a %s Slack listen is judged by its filter alone: the gate proceeds without asking who sent it', async (pin) => {
    let resolved = false;
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin,
      sourceAdapter: { adapterType: 'slack' },
      event: event('slack'),
      resolve: async () => { resolved = true; return null; },
    });
    expect(inboundActorGateEnabled('slack', pin)).toBe(false);
    expect(gate).toEqual({ kind: 'proceed' });
    expect(resolved).toBe(false);
  });

  it('a 0.15.3 Slack listen drops an unregistered sender', async () => {
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: '0.15.3',
      sourceAdapter: adapterWith([{ identity: { identifier: 'U9', scheme: 'email', email: 'stranger@example.com' }, source: 'originator' }]),
      event: event('slack'),
      resolve: async () => null,
    });
    expect(gate.kind).toBe('drop');
  });
});

describe('consultActorGate', () => {
  const candidate: ActorCandidate = {
    identity: { identifier: 'U123', scheme: 'email', adapterType: 'slack', email: 'ada@example.com' },
    source: 'originator',
  };

  it('proceeds when the actor resolves to a registered user', async () => {
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: adapterWith([candidate]),
      event: event('slack'),
      resolve: async () => registered,
    });
    expect(gate).toEqual({ kind: 'proceed' });
  });

  it('drops when the actor does not resolve (unregistered human)', async () => {
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: adapterWith([candidate]),
      event: event('slack'),
      resolve: async () => null,
    });
    expect(gate.kind).toBe('drop');
    if (gate.kind === 'drop') expect(gate.reason).toContain('registered');
  });

  it('drops when there are no candidates at all (the bot self-echo shape)', async () => {
    let sawCandidates: ActorCandidate[] | undefined;
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: adapterWith([]),
      event: event('slack'),
      resolve: async ({ getCandidates }) => {
        sawCandidates = await getCandidates();
        return sawCandidates.length > 0 ? registered : null;
      },
    });
    expect(sawCandidates).toEqual([]);
    expect(gate.kind).toBe('drop');
  });

  it('passes NO trigger context to the resolver (override/fallback cannot reopen the loop)', async () => {
    let sawTrigger: unknown = 'unset';
    await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: adapterWith([candidate]),
      event: event('slack'),
      resolve: async (input) => {
        sawTrigger = (input as { trigger?: unknown }).trigger;
        return registered;
      },
    });
    expect(sawTrigger).toBeUndefined();
  });

  it('an ungated adapter proceeds without consulting the resolver', async () => {
    let resolved = false;
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: adapterWith([candidate]),
      event: event('attio'),
      resolve: async () => { resolved = true; return registered; },
    });
    expect(gate).toEqual({ kind: 'proceed' });
    expect(resolved).toBe(false);
  });

  it('asks a module with no candidates of its own about who acted on the arrival', async () => {
    const actor: ActorCandidate['identity'] = { identifier: 'U123', scheme: 'opaque', adapterType: 'slack', label: 'U123' };
    const arrivalNaming = { adapterType: 'slack', edge: 'Messages', landing: { fields: {} }, actor };
    let sawCandidates: ActorCandidate[] | undefined;
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: { adapterType: 'slack' },
      // A module from before 0.16 named who acted on the arrival itself.
      event: { ...event('slack'), arrival: arrivalNaming },
      resolve: async ({ getCandidates }) => {
        sawCandidates = await getCandidates();
        return registered;
      },
    });
    expect(sawCandidates).toEqual([{ identity: actor, source: 'originator' }]);
    expect(gate).toEqual({ kind: 'proceed' });
  });

  it('drops when neither the module nor the arrival names who acted', async () => {
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: { adapterType: 'slack' },
      event: event('slack'),
      resolve: async () => registered,
    });
    expect(gate.kind).toBe('drop');
  });

  it('a throwing resolver drops (fail closed — the receipt stays replayable)', async () => {
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: adapterWith([candidate]),
      event: event('slack'),
      resolve: async () => { throw new Error('users.info exploded'); },
    });
    expect(gate.kind).toBe('drop');
    if (gate.kind === 'drop') expect(gate.reason).toContain('could not be resolved');
  });

  it('an outage during candidate lookup (users.info throws) drops with the lookup-failure ' +
    'reason, NOT the unregistered-sender reason — even through the real resolveActingUser ' +
    'chain (no `resolve` override)', async () => {
    const outageAdapter: ActorSource = {
      adapterType: 'slack',
      getActorCandidates: async () => {
        throw new Error('missing_scope');
      },
    };
    const gate = await consultActorGate({
      teamId: TEAM_ID,
      pin: PIN,
      sourceAdapter: outageAdapter,
      event: event('slack'),
    });
    expect(gate.kind).toBe('drop');
    if (gate.kind === 'drop') {
      expect(gate.reason).toContain('could not be resolved');
      expect(gate.reason).not.toContain('does not resolve to a registered');
    }
  });
});
