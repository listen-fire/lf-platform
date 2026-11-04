// A tap on a 0.12 callback through the Slack door, as production took it: a signed
// block action in, the value Slack captured at tap time on the ledger and in the
// body's write, and the message replaced once a single use has served it. The run is
// a real 0.12 Run now on 0.12's engine, the door the real route, the reply row the
// real `slack_response` work.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';
import type { CallbackId } from '../../../generated/kysely/automations/Callback';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

jest.mock('../../../interfaces/rest/slackEvents', () => ({
  verifySlackEventsRequest: () => ({ authorized: true }),
}));

import { slackInteractivityRouter } from '../../../interfaces/rest/slackInteractivity';
import { getAsksQb, getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { RETIRED_CALLBACK_TEXT } from '../../interaction/retired_callback';
import { registerSlackResponseWork } from '../../webhook_sync/slack_response_url';
import { runMovementAsync } from '../../translation_graph/movement/run_now';
import { mintMovementVersionIfChanged } from '../../translation_graph/movement/version_store';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { registerCoreWork } from '../../work/register';

const RESPONSE_URL = 'https://hooks.slack.example/response/1';

const programWith = (param: string) => `import { \`@lf/ask\` as ask } from adapters
qa = connect ask
function go(run: <manual-[:Invocation]->>) {
  cb = callback((picked: ${param}) => {
    write qa-[:Form]-> { Prompt: "picked \${picked}", Fields: ["body"] }
  })
  c = await first(cb-[:Called]->)
  return c
}
listen to manual fire go
`;

describe('a tap on a 0.12 callback through the Slack door', () => {
  let teamId: TeamId;
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    resetWorkHandlersForTests();
    registerCoreWork();
    registerSlackResponseWork();
    setWorkNotifier({ notify() {} });
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `doors-${teamId.slice(0, 8)}` } as never).execute();
    const app = express();
    app.use('/api/public/slack-actions', express.raw({ type: '*/*' }), slackInteractivityRouter as Router);
    server = createServer(app);
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((closed) => server.close(closed));
    setWorkNotifier(inProcessNotifier);
    resetWorkHandlersForTests();
    await cleanupTeam(teamId);
  });

  afterEach(async () => {
    await getAutomationsQb(['work']).deleteFrom('work').where('kind', '=', 'slack_response').execute();
  });

  /** What the door queued to tell the tapper: the row carries no team, so a
   *  drain of the team leaves it, and it is read here. */
  const replies = async () => {
    const rows = await getAutomationsQb(['work']).selectFrom('work').where('kind', '=', 'slack_response').select('payload').execute();
    return rows.map((row) => row.payload);
  };

  async function parkedOnCallback(name: string, param: string): Promise<{ runId: TriggerRunId; callbackId: CallbackId }> {
    const movementId = randomUUID();
    const source = programWith(param);
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: movementId as MovementId, team_id: teamId, name, source, description: '', language_version: '0.12.13' } as never)
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId, source, languageVersion: '0.12.13' });
    const queued = await runMovementAsync({ teamId, movementId, text: 'pressed' });
    if (!queued.ok) throw new Error(queued.errors.join('; '));
    await drainUntilIdle({ teamId, heartbeatMs: false });
    const runId = queued.runId as TriggerRunId;
    const callback = await getAutomationsQb(['callback']).selectFrom('callback').where('run_id', '=', runId).select('id').executeTakeFirstOrThrow();
    return { runId, callbackId: callback.id };
  }

  const tap = (action: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/public/slack-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', response_url: RESPONSE_URL, trigger_id: randomUUID(), actions: [action] }) }).toString(),
    });

  it.each([
    ['date picker', 'date_tap', '<date>', (id: string) => ({ type: 'datepicker', action_id: id, selected_date: '2026-11-05' }), '2026-11-05'],
    ['time picker', 'time_tap', '<text>', (id: string) => ({ type: 'timepicker', action_id: id, selected_time: '14:30' }), '14:30'],
  ])('a %s: its value reaches the run, and the message is replaced', async (_control, name, param, action, value) => {
    const { runId, callbackId } = await parkedOnCallback(name, param);
    expect((await tap(action(callbackId))).status).toBe(200);
    await drainUntilIdle({ teamId, heartbeatMs: false });

    const ledger = await getAutomationsQb(['callback']).selectFrom('callback').where('id', '=', callbackId).select(['calls', 'status']).executeTakeFirstOrThrow();
    expect(ledger.status).toBe('fired');
    expect(ledger.calls).toEqual([expect.objectContaining({ values: { picked: value } })]);
    const run = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select(['status', 'failure_reason']).executeTakeFirstOrThrow();
    expect(run).toMatchObject({ status: 'success' });
    const written = await getAsksQb(['ask']).selectFrom('ask').where('team_id', '=', teamId).where('prompt', 'like', `picked %${value}%`).select('prompt').execute();
    expect(written).toHaveLength(1);
    expect(await replies()).toEqual([{ responseUrl: RESPONSE_URL, body: expect.objectContaining({ replace_original: true, text: 'Thanks — that has been recorded.' }) }]);
  });

  it('an id no run holds is told the button was retired, and the message stays', async () => {
    expect((await tap({ type: 'button', action_id: 'ship', value: 'cb_no_run_holds_this' })).status).toBe(200);
    expect(await replies()).toEqual([{ responseUrl: RESPONSE_URL, body: { response_type: 'ephemeral', replace_original: false, text: RETIRED_CALLBACK_TEXT } }]);
  });
});
