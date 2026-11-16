// The team's host functions as a cloud lf is served them: adapter protocol 2's
// `manifest` and `invokePlugin` for the tenant of the key's owner, over the
// platform's real tables.

import { randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { ProvisioningService } from '../../../../services/provisioning';
import { teamPluginHandler } from '../team_plugin';

let team: TeamId;
let email: string;

beforeEach(async () => {
  team = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: team, name: `team-plugin-${team.slice(0, 8)}` }).execute();
  email = `ada-${team.slice(0, 8)}@acme.test`;
  await ProvisioningService.provisionUser({ teamId: team, email, access: 'admin' });
});

afterEach(async () => {
  await cleanupTeam(team);
});

async function post(body: unknown): Promise<{ status: number; body: any }> {
  let answered: { status: number; body: unknown } | undefined;
  const res = {
    status(code: number) {
      return { json: (payload: unknown) => void (answered = { status: code, body: payload }) };
    },
  };
  // The tenant is the key owner's team, whatever the request's header says.
  await teamPluginHandler(() => team)({ body, headers: { 'x-listen-fire-team': randomUUID() } } as unknown as Request, res as unknown as Response, () => undefined);
  if (answered === undefined) throw new Error('test: the handler answered nothing');
  return answered as { status: number; body: any };
}

const envelope = (method: string, params: unknown) => ({ protocolVersion: '2', method, params, cacheScopeId: 'test' });

describe('the team plugin served to lf', () => {
  it('describes both functions as pure, with a maximum age', async () => {
    const { body } = await post(envelope('manifest', {}));
    expect(body.ok).toBe(true);
    expect(body.result.plugins.package).toBe('@lf-platform/team');
    expect(body.result.plugins.plugins.map((p: { name: string }) => p.name)).toEqual(['is-member', 'user-for']);
    for (const plugin of body.result.plugins.plugins) expect(plugin.spec).toMatchObject({ pure: true, maxAgeSeconds: 300 });
  });

  it('answers isMember and userFor for the key owner’s team', async () => {
    const member = await post(envelope('invokePlugin', { name: 'is-member', config: { claim: email }, extractedContext: {} }));
    expect(member.body).toEqual({ ok: true, result: { data: { value: true } } });
    const stranger = await post(envelope('invokePlugin', { name: 'is_member', config: { claim: 'nobody@acme.test' }, extractedContext: {} }));
    expect(stranger.body).toEqual({ ok: true, result: { data: { value: false } } });
    const user = await post(envelope('invokePlugin', { name: 'user-for', config: { claim: email }, extractedContext: {} }));
    expect(user.body.result.data.value).toMatchObject({ Email: email, Level: 'admin' });
  });

  it('refuses a method a plugin module does not have', async () => {
    const { body } = await post(envelope('poll', { edge: 'Events' }));
    expect(body).toMatchObject({ ok: false, error: { code: 'method_not_implemented' } });
  });

  it('refuses a body that is not an envelope', async () => {
    expect((await post({ nonsense: true })).status).toBe(400);
  });
});
