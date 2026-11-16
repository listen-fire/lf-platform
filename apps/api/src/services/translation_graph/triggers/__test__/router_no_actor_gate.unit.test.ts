// The router holds no ownership gate. A listen on this release's pin (0.16 or
// later) is judged by its filter alone at the door, so a message the door let
// through runs whoever sent it. A listen on a carried pin (0.15.3) is never
// dispatched by the router at all in production; it is read, gated and fired
// by its own version in dispatch_event (the 0.15 gate cases:
// services/inbound/__test__/carried_015_listen.integration.test.ts, and the
// whole flow in carried_015_flow.integration.test.ts). Were one to reach the
// router, it still asks nobody who sent the message.

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

describe('the router does not consult the ownership gate', () => {
  it.each(['0.15.3', '0.16.0', LANGUAGE_VERSION])('a %s Slack listen runs for an unregistered sender, asking nobody who they are', async (pin) => {
    pinnedTo(pin);
    mockResolveActingUser.mockResolvedValue(null);
    const result = await dispatchTriggerByIdEvent({ triggerId: 't1', event: slackMessage, teamId: TEAM_ID });
    expect(result.droppedReason).toBeUndefined();
    expect(mockRunMovementFiring).toHaveBeenCalledTimes(1);
    expect(mockResolveActingUser).not.toHaveBeenCalled();
    expect(mockResolveAdapter).not.toHaveBeenCalled();
  });
});
