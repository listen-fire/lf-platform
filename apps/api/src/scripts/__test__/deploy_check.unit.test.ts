// The summary `deploy/up.sh` prints: outcomes by automation name.

jest.mock('../../services', () => ({}));
jest.mock('../../services/translation_graph/movement/language_upgrade', () => ({
  DEPLOY_CHECK_OUTCOMES: ['upgradable', 'current', 'warned', 'refused', 'unverified'],
  latestDeployCheckSummary: jest.fn(),
  liveDeployCheckDeps: jest.fn(),
  runDeployCheck: jest.fn(),
  thisDeployCheckRelease: jest.fn(),
}));

import { renderSummary } from '../deploy_check';

const LEGACY = { version: '4', name: '4' };
const INSTALLED = { version: '0.12.0', name: '0.12.0' };

describe('renderSummary', () => {
  it('lists upgradable, warned and refused automations by name, and counts the already-current', () => {
    const text = renderSummary({
      release: 'v0.8.0',
      languageRelease: 'current=0.12.0;legacy=1,2,3,4',
      current: INSTALLED,
      ranAt: '2026-09-29T12:00:00.000Z',
      counts: { upgradable: 1, current: 2, warned: 1, refused: 0, unverified: 0 },
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
  });
});
