// The summary `deploy/up.sh` prints: outcomes by automation name.

jest.mock('../../services', () => ({}));
jest.mock('../../products', () => ({ mounts: () => true }));
jest.mock('../../services/translation_graph/movement/dropped_pins', () => ({ droppedPins: jest.fn(async () => ({ automations: [], parkedRuns: [] })) }));
jest.mock('../../services/translation_graph/movement/language_upgrade', () => ({
  DEPLOY_CHECK_OUTCOMES: ['upgradable', 'current', 'warned', 'refused', 'unverified'],
  latestDeployCheckSummary: jest.fn(),
  liveDeployCheckDeps: jest.fn(),
  ReleaseSyncNotQueued: class ReleaseSyncNotQueued extends Error {},
  runDeployCheck: jest.fn(),
  thisDeployCheckRelease: jest.fn(),
}));

import { ReleaseSyncNotQueued, runDeployCheck } from '../../services/translation_graph/movement/language_upgrade';
import { deployCheckMain, renderSummary } from '../deploy_check';

const LEGACY = { version: '4', name: '4' };
const INSTALLED = { version: '0.12.0', name: '0.12.0' };

describe('renderSummary', () => {
  it('lists upgradable, warned and refused automations by name, and counts the already-current', () => {
    const text = renderSummary({
      release: 'v0.8.0',
      languageRelease: 'current=0.12.0;legacy=1,2,3,4',
      current: INSTALLED,
      ranAt: '2026-09-29T12:00:00.000Z',
      counts: { upgradable: 1, current: 2, carried: 0, warned: 1, stopped: 0, refused: 0, unverified: 0 },
      automations: [
        { id: 'a', teamId: 't', name: 'Sync CRM', outcome: 'upgradable', from: LEGACY, to: INSTALLED, deprecated: false, detail: '' },
        { id: 'b', teamId: 't', name: 'Digest', outcome: 'current', from: INSTALLED, to: INSTALLED, deprecated: false, detail: '' },
        { id: 'c', teamId: 't', name: 'Other', outcome: 'current', from: INSTALLED, to: INSTALLED, deprecated: false, detail: '' },
        { id: 'd', teamId: 't', name: 'Intake', outcome: 'warned', from: LEGACY, to: LEGACY, deprecated: false, detail: 'line 3: changed meaning' },
      ],
    });

    expect(text).toContain('Deploy check for release v0.8.0');
    expect(text).toContain('installed language 0.12.0');
    expect(text).toContain('Legacy versions clean under the installed language — offered the upgrade, pin unchanged: 1');
    expect(text).toContain('- Sync CRM (4 -> 0.12.0)');
    expect(text).toContain('On the installed language: 2');
    expect(text).not.toContain('Digest');
    expect(text).toContain('- Intake (4) — line 3: changed meaning');
    // A summary recorded before the check recorded its sync says nothing of one.
    expect(text).not.toContain('sync of listen subscriptions');
  });

  it("says the release's sync of listen subscriptions was queued, with its work row's key", () => {
    const text = renderSummary({
      release: 'v0.16.2',
      languageRelease: 'current=0.16.0;legacy=1,2,3,4',
      current: INSTALLED,
      ranAt: '2026-11-17T06:00:00.000Z',
      counts: { upgradable: 0, current: 0, carried: 0, warned: 0, stopped: 0, refused: 0, unverified: 0 },
      automations: [],
      subscriptionSync: { workKey: 'listen_subscription_release_sync:v0.16.2' },
    });

    expect(text.split('\n').filter((line) => line.includes('sync of listen subscriptions'))).toEqual([
      "  Queued the release's sync of listen subscriptions, which the api runs once it is up: work listen_subscription_release_sync:v0.16.2",
    ]);
  });

  it('says of a paused run only what can still be done after the deploy', () => {
    const text = renderSummary({
      release: 'v0.8.0',
      languageRelease: 'current=0.12.0;legacy=1,2,3,4',
      current: INSTALLED,
      ranAt: '2026-09-29T12:00:00.000Z',
      counts: { upgradable: 0, current: 0, carried: 0, warned: 0, stopped: 0, refused: 0, unverified: 0 },
      automations: [],
      legacyStopped: [{ name: 'Intake', pin: '4', movementId: 'm', waitingRuns: ['run-1'], remedy: 'upgrade it' }],
    });

    expect(text).toContain('run-1. Cancel them, then upgrade the automation');
    expect(text).not.toMatch(/before deploying|on 0\.12\.13/);
  });
});

describe('deployCheckMain', () => {
  it("stops the deployment when the release's sync of listen subscriptions could not be queued", async () => {
    jest.mocked(runDeployCheck).mockRejectedValueOnce(new ReleaseSyncNotQueued({ cause: new Error('the database refused the write') }));
    expect(await deployCheckMain()).toBe(1);
  });

  it('lets the deployment go ahead when the sweep cannot finish for another reason: it moves no pin', async () => {
    jest.mocked(runDeployCheck).mockRejectedValueOnce(new Error('a movement could not be listed'));
    expect(await deployCheckMain()).toBe(0);
  });
});
