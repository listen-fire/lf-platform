// A park lf commits through the store module is the platform's to show: the
// runs view lists the run beside the platform's own, with its status, what it
// is waiting on, and its movement's name (real DB).

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { cleanupTeam } from '../../../test/harness/cleanup';
import { answerFor } from '../../lf_store/answer';
import { listParkedRuns, listTeamRuns } from '../observability';

let teamId: TeamId;

beforeEach(() => {
  teamId = randomUUID() as TeamId;
});

afterEach(async () => {
  await cleanupTeam(teamId);
});

describe('lf runs in the runs view', () => {
  it('an lf run parked on a timer is listed parked, waiting on timer, named by its movement', async () => {
    const store = answerFor({ tenant: teamId });
    const call = (method: string, params: Record<string, unknown>) => store(method, params, {});
    const runId = randomUUID();
    await call('runs.start', { id: runId, file: 'welcome.lf', movement: 'welcome', startedAt: new Date().toISOString(), input: '{}' });
    const lease = (await call('leases.claim', { runId, ttlMs: 60_000 })) as { token: string };
    const wakeAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await call('parks.commit', { runId, address: 's0', state: {}, fence: lease.token, park: { kind: 'timer', wakeAt } });

    expect(await listTeamRuns(teamId)).toEqual([
      expect.objectContaining({ runId, status: 'parked', waitingOn: 'timer', automationName: 'welcome', cancelRequested: false }),
    ]);
    expect(await listParkedRuns(teamId)).toEqual([expect.objectContaining({ runId, automationName: 'welcome' })]);
  });
});
