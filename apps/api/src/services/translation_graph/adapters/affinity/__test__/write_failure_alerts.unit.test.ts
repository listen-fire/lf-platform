// The platform's reporter for Affinity writes the module walked past: each
// kind the module reports reaches ops as one DEALFLOW Slack notification.

const mockSlack = jest.fn();
jest.mock('../../../../../lib/slack', () => ({
  sendSlackNotification: (...a: unknown[]) => mockSlack(...a),
}));

import { reportAffinityWriteFailure } from '@listen-fire/affinity/write_failures';
import '../write_failure_alerts';

describe('the Affinity write failure alert', () => {
  beforeEach(() => mockSlack.mockReset());

  it('sends one DEALFLOW notification carrying the detail when a domain is refused', async () => {
    const detail = 'new organisation: Bücher, domain: xn--bcher-kva.example';
    await reportAffinityWriteFailure({ kind: 'domain', detail });

    expect(mockSlack).toHaveBeenCalledTimes(1);
    const sent = mockSlack.mock.calls[0][0];
    expect(sent.type).toBe('DEALFLOW');
    expect(sent.text).toContain(detail);
    expect(sent.opsTitle).toBe('Affinity refused an organisation domain');
  });
});
