// The REST upgrade of a 0.15 Slack automation over a real row and the team's
// live catalog: its open listen holds the pin and carries the team's check as a
// fix for review; accepting it applies the edit, moves the pin, and the result
// checks clean under the current release.

import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';
import { LANGUAGE_VERSION } from 'movement-lang';
import { runWithPrincipal } from 'principal';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { SLACK_APP_ID } from '../../../../services/credentials/app_id';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { setStatement } from '../../../../services/access/decide';
import { userPrincipal } from '../../../../services/principal';
import { ProvisioningService } from '../../../../services/provisioning';
import { validateMovementForTeam } from '../../../../services/translation_graph/movement/authoring';
import { upgradeMovementHandler } from '../knowledge_agent_tools';

jest.mock('../../../../services/credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));
jest.mock('../../../../lib/slack', () => ({ sendSlackNotification: async () => undefined }));

const OLD_SLACK = `chat = connect \`@lf/slack\` using \`Slack\`

function old_slack(m: <chat-[:Message]->>) {
  return m.\`Message\`
}

listen to chat-[:Channels]->-[:Messages]-> fire old_slack
`;

let teamId: TeamId;
let admin: UserId;
let movementId: MovementId;

const asAdmin = () => userPrincipal({ userId: admin, teamId, access: 'admin' });

async function post(handler: RequestHandler, body: unknown): Promise<Record<string, any>> {
  let answered: Record<string, any> | undefined;
  const res = {
    status: () => res,
    json: (payload: Record<string, any>) => {
      answered = payload;
      return res;
    },
  };
  await runWithPrincipal(asAdmin(), async () => {
    await handler({ body } as never, res as never, (() => undefined) as never);
  });
  if (answered === undefined) throw new Error('test: the handler answered nothing');
  return answered;
}

async function stored(): Promise<{ source: string; language_version: string }> {
  return getAutomationsQb(['movement']).selectFrom('movement').select(['source', 'language_version']).where('id', '=', movementId).executeTakeFirstOrThrow();
}

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `upgrade-open-${teamId.slice(0, 8)}` }).execute();
  admin = (await ProvisioningService.provisionUser({ teamId, email: `upgrade-open-${teamId.slice(0, 8)}@acme.test`, access: 'admin' })).userId;
  const slack = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({ id: slack, team_id: teamId, type: ExternalServiceType.SLACK, name: 'Slack', credentials: null, user_id: null, app_id: SLACK_APP_ID.movements })
    .execute();
  movementId = randomUUID() as MovementId;
  // A 0.15.3 save is refused now, so the row is written as one made then.
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    .values({ id: movementId, team_id: teamId, name: 'old_slack', source: OLD_SLACK, description: '', language_version: '0.15.3' })
    .execute();
  await runWithPrincipal(asAdmin(), async () => {
    await setStatement(asAdmin(), { target: { thing: 'connection', id: slack }, verb: 'use', grantees: [{ kind: 'team' }] });
    await setStatement(asAdmin(), { target: { thing: 'automation', id: movementId }, verb: 'read', grantees: [{ kind: 'team' }] });
    await setStatement(asAdmin(), { target: { thing: 'automation', id: movementId }, verb: 'write', grantees: [{ kind: 'team' }] });
  });
});

afterEach(async () => {
  for (const table of ['work', 'access_statement', 'trigger', 'movement_version', 'movement', 'webhook_subscription'] as const) {
    await getAutomationsQb([table]).deleteFrom(table).where('team_id', '=', teamId).execute();
  }
  await cleanupTeam(teamId);
});

describe('upgrading an open 0.15 Slack listen through REST', () => {
  it('holds the pin until the fix is accepted: acknowledging alone moves nothing', async () => {
    const held = await post(upgradeMovementHandler, { automation: 'old_slack' });
    expect(held.status).toBe('blocked');
    expect((held.diagnostics as Array<{ code: string }>).map((d) => d.code)).toEqual(['MOV_LISTEN_NOW_OPEN']);
    expect(await stored()).toEqual({ source: OLD_SLACK, language_version: '0.15.3' });

    const acknowledged = await post(upgradeMovementHandler, { automation: 'old_slack', acknowledge: true });
    expect(acknowledged.status).toBe('blocked');
    expect(await stored()).toEqual({ source: OLD_SLACK, language_version: '0.15.3' });
  });

  it('offers the team check as a fix for review', async () => {
    const held = await post(upgradeMovementHandler, { automation: 'old_slack' });
    const [open] = (held.diagnostics as Array<{ code: string; fix?: { safe?: boolean; edits: Array<{ text: string }> } }>).filter((d) => d.code === 'MOV_LISTEN_NOW_OPEN');
    expect(open?.fix?.safe).toBeFalsy();
    expect(open?.fix?.edits.map((edit) => edit.text).join('')).toContain('.isMember(');
  });

  it('applies the edit when the fix is accepted, and the result checks clean', async () => {
    const moved = await post(upgradeMovementHandler, { automation: 'old_slack', applyAllFixes: true, acknowledge: true });
    expect(moved.status).toBe('upgraded');
    const after = await stored();
    expect(after.language_version).toBe(LANGUAGE_VERSION);
    expect(after.source).toContain('import { `@lf-platform/team` as team } from plugins');
    expect(after.source.split('.isMember(').length - 1).toBe(1);
    const checked = await runWithPrincipal(asAdmin(), () =>
      validateMovementForTeam({ teamId, source: after.source, audience: { for: 'run' }, languageVersion: LANGUAGE_VERSION }),
    );
    expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
