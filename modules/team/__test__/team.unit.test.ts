// The module's surface and how it reads a claim: an address or a number, the
// member (if any) the platform's records name, and the declarations a checker
// and a host cache read.

import { pluginsInProcess, noCredential, refusingFiles, refusingKv, type ModuleHost } from 'module-kit';
import { pluginSpecsOf } from '@listen-fire/engine-contracts/plugin_spec';

import { TEAM_MAX_AGE_SECONDS, teamModuleWith, type TeamMember, type TeamRecords } from '../index';

const ADA: TeamMember = { id: 'user-ada', email: 'ada@example.com', name: 'Ada', level: 'admin' };

function records(overrides: Partial<TeamRecords> = {}): TeamRecords & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    memberByEmail: async (email) => {
      asked.push(`email:${email}`);
      return email === ADA.email ? ADA : null;
    },
    memberByPhone: async (phone) => {
      asked.push(`phone:${phone}`);
      return phone === '+447700900123' ? ADA : null;
    },
    ...overrides,
  };
}

const quiet = () => undefined;

function loaded(forRecords: TeamRecords) {
  const host: ModuleHost = {
    tenant: 'team-1',
    credential: noCredential('@lf-platform/team needs none'),
    log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    files: refusingFiles('no files'),
    kv: refusingKv('no kv'),
    validateResults: true,
  };
  return pluginsInProcess(teamModuleWith(() => forRecords), host);
}

const call = (module: ReturnType<typeof loaded>, name: string, claim: unknown) => module.invoke({ name, config: { claim }, extractedContext: {} });

describe('@lf-platform/team', () => {
  it('declares both functions pure, with a maximum age, taking either claim', () => {
    const definition = teamModuleWith(() => records());
    const specs = pluginSpecsOf(definition.plugins);
    expect(Object.keys(specs).sort()).toEqual(['is_member', 'user_for']);
    for (const spec of Object.values(specs)) {
      expect(spec).toMatchObject({ pure: true, maxAgeSeconds: TEAM_MAX_AGE_SECONDS, requiredArgs: ['claim'] });
    }
    expect(TEAM_MAX_AGE_SECONDS).toBe(300);
    expect(specs.is_member?.argTypes?.claim).toEqual({
      kind: 'union',
      of: [
        { kind: 'branded', of: 'text', brands: ['claim:email/address'] },
        { kind: 'branded', of: 'text', brands: ['claim:phone/e164'] },
      ],
    });
  });

  it('answers isMember for an address, lower case and trimmed', async () => {
    const forRecords = records();
    const module = loaded(forRecords);
    expect(await call(module, 'is-member', '  Ada@Example.com ')).toEqual({ data: { value: true } });
    expect(await call(module, 'is-member', 'bob@example.com')).toEqual({ data: { value: false } });
    expect(forRecords.asked).toEqual(['email:ada@example.com', 'email:bob@example.com']);
  });

  it('asks for a phone number by number', async () => {
    const forRecords = records();
    const module = loaded(forRecords);
    expect(await call(module, 'is-member', '+447700900123')).toEqual({ data: { value: true } });
    expect(await call(module, 'is-member', '+447700900124')).toEqual({ data: { value: false } });
    expect(forRecords.asked).toEqual(['phone:+447700900123', 'phone:+447700900124']);
  });

  it('answers userFor with the member, or nothing', async () => {
    const module = loaded(records());
    expect(await call(module, 'user-for', 'ada@example.com')).toEqual({
      data: { value: { Id: 'user-ada', Email: 'ada@example.com', Name: 'Ada', Level: 'admin' } },
    });
    expect(await call(module, 'user-for', 'bob@example.com')).toEqual({ data: { value: null } });
  });

  it('refuses a claim that is not text, and a plugin it does not have', async () => {
    const module = loaded(records());
    await expect(call(module, 'is-member', 42)).rejects.toThrow('a claim is text');
    await expect(call(module, 'nobody', 'ada@example.com')).rejects.toThrow('has no plugin "nobody"');
  });
});
