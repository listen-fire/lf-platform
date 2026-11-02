// The wake over the Cloud Tasks module and its fake, as the platform installs
// it: rows written through the real work table become tasks named for their
// coalescing window, a burst coalesces, a shared poll's next due becomes a
// task at its minute, and the task starts the job with the invoker's token.
// The module's clock is held still so a test never straddles a window.

import { randomUUID } from 'node:crypto';

jest.mock('../../poll_source/edge_poller', () => ({
  // Only this file's polled module, so other suites' leftover listens stay out of it.
  edgePollerOf: async (input: { adapterType: string }) =>
    input.adapterType === 'wake_test_poll' ? async () => ({ arrivals: [], cursor: 'now' }) : null,
}));

import { CloudTasksWake, readInstall } from '@listen-fire/wake-cloud-tasks/cloud_tasks';
import { fakeCloudTasks, type FakeCloudTasks } from '@listen-fire/wake-cloud-tasks/fake_cloud_tasks';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { testWorkContext } from '../../../test/harness/work';
import { insertTestListen } from '../../../test/harness/listens';
import { pollEdgeHandler, pollWorkKey, sharedPolls } from '../../poll_source/worker';
import { enqueueWork, listWorkByKind, removeWork } from '../store';
import { installWake, resetWakeForTests, settleWakes } from '../wake';

const QUEUE = 'projects/dev/locations/local/queues/lf-wake';
const JOB = 'projects/dev/locations/local/jobs/lf-drain';
const INVOKER = 'lf-drain-invoker@dev.iam.gserviceaccount.com';
const MINUTE = 60_000;

let fake: FakeCloudTasks;
let clock: number;
let teamId: TeamId;
let movementId: MovementId;
const keys: string[] = [];

function taskName(index: number): string {
  return `${QUEUE}/tasks/lf-drain-${index}`;
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  movementId = randomUUID() as MovementId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `cloud-tasks-wake-${teamId.slice(0, 8)}` } as any)
    .execute();
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ id: movementId, team_id: teamId, name: 'wake test', source: '' })
    .execute();
});

beforeEach(async () => {
  // Far enough from a window's end that the test's own seconds stay inside it.
  clock = Math.floor(Date.now() / MINUTE) * MINUTE + 5_000;
  fake = await fakeCloudTasks({ dispatch: 'manual', now: () => clock });
  installWake(
    new CloudTasksWake(readInstall({ queue: QUEUE, job: JOB, invoker_service_account: INVOKER, base_url: fake.url }), {
      now: () => clock,
      accessToken: async () => 'Bearer api-token',
    }),
  );
});

afterEach(async () => {
  await settleWakes(5_000);
  resetWakeForTests();
  await fake.close();
  for (const key of keys.splice(0)) await removeWork({ key });
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
});

afterAll(async () => {
  await getAutomationsQb(['movement']).deleteFrom('movement').where('id', '=', movementId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

async function enqueueNow(): Promise<void> {
  const key = `resume_timer:${randomUUID()}`;
  keys.push(key);
  await enqueueWork({ kind: 'resume_timer', key, teamId, payload: {} });
}

describe('the wake over Cloud Tasks', () => {
  it('ten enqueues in one window make one task', async () => {
    const window = Math.floor(clock / MINUTE);
    await Promise.all(Array.from({ length: 10 }, () => enqueueNow()));

    expect(fake.created.map((each) => each.name)).toEqual([taskName(window)]);
    expect(fake.created[0]?.scheduleTime).toBe(new Date(clock).toISOString());
    // The nine others found it present.
    expect(fake.gets.filter((get) => get.name === taskName(window) && get.status === 200)).toHaveLength(9);

    // Once that task has run, the next enqueue makes the next window's.
    await fake.dispatchDue();
    expect(fake.runs.map((run) => run.name)).toEqual([taskName(window)]);
    await enqueueNow();
    expect(fake.created.map((each) => each.name)).toEqual([taskName(window), taskName(window + 1)]);
    expect(fake.created[1]?.scheduleTime).toBe(new Date((window + 1) * MINUTE).toISOString());
  });

  it("the task carries the invoker's OAuth token for run.googleapis.com, never an OIDC token, and the create call carries the caller's own credential", async () => {
    await enqueueNow();
    const [created] = fake.created;
    if (!created) throw new Error('no task created');
    expect(created.authorization).toBe('Bearer api-token');
    expect(created.task.httpRequest).toEqual({
      url: `https://run.googleapis.com/v2/${JOB}:run`,
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{}').toString('base64'),
      oauthToken: { serviceAccountEmail: INVOKER, scope: 'https://www.googleapis.com/auth/cloud-platform' },
    });
    expect(created.task.httpRequest.oidcToken).toBeUndefined();

    await fake.dispatchDue();
    expect(fake.runs.map((run) => run.authorization)).toEqual([`Bearer fake-oauth:${INVOKER}`]);
  });

  it("a shared poll's next due makes a task at its window's end", async () => {
    await insertTestListen({ teamId, movementId, adapterType: 'wake_test_poll', edge: 'Things', delivery: 'polled', pollEverySeconds: 120 });
    const [poll] = await sharedPolls({ teamId });
    if (poll === undefined) throw new Error('the listen shares no poll');
    keys.push(pollWorkKey(poll.digest));

    // Polled now, every 2 minutes: due 120 s after the poll ended.
    const started = Date.now();
    await pollEdgeHandler.run({ teamId, digest: poll.digest }, testWorkContext(new Date(clock)));
    const took = Date.now() - started;

    const row = (await listWorkByKind('poll_edge')).find((each) => each.key === pollWorkKey(poll.digest));
    if (!row) throw new Error('the poll was not armed');
    expect(row.dueAt.getTime()).toBeGreaterThanOrEqual(clock + 120_000);
    expect(row.dueAt.getTime()).toBeLessThanOrEqual(clock + 120_000 + took);
    const index = Math.ceil(row.dueAt.getTime() / MINUTE);
    expect(fake.created.map((each) => [each.name, each.scheduleTime])).toEqual([
      [taskName(index), new Date(index * MINUTE).toISOString()],
    ]);
    // Never before the row is due, at most a window late.
    expect(index * MINUTE).toBeGreaterThanOrEqual(row.dueAt.getTime());
    expect(index * MINUTE - row.dueAt.getTime()).toBeLessThan(MINUTE);
  });
});
