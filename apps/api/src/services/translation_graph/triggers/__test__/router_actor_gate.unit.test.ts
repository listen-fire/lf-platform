// The router's ownership gate runs for every pin: only registered team members'
// Slack messages set an automation off.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { LANGUAGE_VERSION } from 'movement-lang';

import { dispatchTriggerByIdEvent } from '../router';

const mockRunMovementFiring = jest.fn();
const mockResolveActingUser = jest.fn();
const mockResolveAdapter = jest.fn();
let mockPins: { row: string; version: string } = { row: '', version: '' };

jest.mock('../../../lf_engine/team_engine', () => ({ isLfEngineTeam: async () => false }));
jest.mock('../../storage/tg_table', () => ({
  loadTriggerById: async () => ({ id: 't1', name: 'm', movementId: 'm1', runMode: 'live', credentialsId: null, firedMovementName: null }),
}));
jest.mock('../../adapters/resolve', () => ({ resolveAdapter: (input: unknown) => mockResolveAdapter(input) }));
jest.mock('../../adapters/acting_user/resolve', () => ({ resolveActingUser: (input: unknown) => mockResolveActingUser(input) }));
jest.mock('../../runs/trigger_run', () => ({ TriggerRunRecorder: class {} }));
jest.mock('../../../loop_guard', () => ({
  loadGuardPausedState: async () => ({ pausedAt: null }),
  evaluate: async () => ({ kind: 'allow' }),
  recordExternalWrites: async () => undefined,
}));
jest.mock('../../../loop_guard/notify', () => ({ notifyBreach: async () => undefined }));
jest.mock('../../../loop_guard/thresholds', () => ({ resolveThresholds: () => ({}) }));
jest.mock('../../movement/execute', () => ({
  doorRefusal: () => undefined,
  runMovementFiring: (input: unknown) => mockRunMovementFiring(input),
  shippedMovementForTrigger: async () => ({
    kind: 'shipped',
    movement: { row: { languageVersion: mockPins.row }, version: { id: 'v1', languageVersion: mockPins.version } },
  }),
}));

const TEAM_ID = 'team-1' as TeamId;

const slackMessage: TriggerEvent = {
  pipelineInputId: 'trigger:t1',
  adapterType: 'slack',
  triggerType: 'webhook',
  payload: { type: 'message', user: 'U123', text: 'hi', channel: 'C1', ts: '1.0' },
  occurredAt: new Date().toISOString(),
};

function pinnedTo(pin: string): void {
  mockPins = { row: pin, version: pin };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRunMovementFiring.mockResolvedValue({ result: { movementName: 'm', writes: [] } });
  mockResolveAdapter.mockResolvedValue({
    adapterType: 'slack',
    getActorCandidates: async () => [{ identity: { identifier: 'U123', scheme: 'email', adapterType: 'slack', email: 'stranger@example.com' }, source: 'originator' }],
  });
});

describe('the gate runs for a current pin as it does on main', () => {
  it.each([LANGUAGE_VERSION, '0.12.13'])('suppresses an unregistered Slack sender on a %s automation', async (pin) => {
    pinnedTo(pin);
    mockResolveActingUser.mockResolvedValue(null);
    const result = await dispatchTriggerByIdEvent({ triggerId: 't1', event: slackMessage, teamId: TEAM_ID });
    expect(result.droppedReason).toBe('actor_unregistered');
    expect(mockRunMovementFiring).not.toHaveBeenCalled();
  });

  it.each([LANGUAGE_VERSION, '0.12.13'])('lets a registered Slack sender through on a %s automation', async (pin) => {
    pinnedTo(pin);
    mockResolveActingUser.mockResolvedValue({ id: 'u-1', email: 'ada@example.com', name: 'Ada' });
    const result = await dispatchTriggerByIdEvent({ triggerId: 't1', event: slackMessage, teamId: TEAM_ID });
    expect(result.droppedReason).toBeUndefined();
    expect(mockRunMovementFiring).toHaveBeenCalledTimes(1);
  });
});
