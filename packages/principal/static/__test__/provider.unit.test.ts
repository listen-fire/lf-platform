import { staticConfigFromEnv, type StaticIdentityConfig } from '../config';
import { createStaticPrincipalProvider } from '../provider';
import { TeamScopeError, type PrincipalRequest } from '../../principal';

const TEAM = '11111111-1111-1111-1111-111111111111';

function request(headers: Record<string, string> = {}): PrincipalRequest {
  return {
    method: 'GET',
    url: '/v1/things',
    header: (name) => headers[name.toLowerCase()],
    cookie: () => undefined,
  };
}

function requestWithCookies(cookies: Record<string, string>): PrincipalRequest {
  return { ...request(), cookie: (name) => cookies[name] };
}

function config(overrides: Partial<StaticIdentityConfig> = {}): StaticIdentityConfig {
  return {
    teamId: TEAM,
    teamName: 'Local',
    userId: 'user-1',
    apiKey: 'sekrit',
    allowAnonymous: false,
    access: 'write',
    scopes: ['*'],
    directory: { team: { id: TEAM, name: 'Local' }, users: [] },
    ...overrides,
  };
}

describe('staticConfigFromEnv', () => {
  it('defaults to the all-zeros team, admin access and the wildcard scope', () => {
    const parsed = staticConfigFromEnv({ LISTEN_FIRE_API_KEY: 'sekrit' });

    expect(parsed.teamId).toBe('00000000-0000-0000-0000-000000000000');
    expect(parsed.teamName).toBe('Local');
    expect(parsed.access).toBe('admin');
    expect(parsed.scopes).toEqual(['*']);
    expect(parsed.directory.users).toEqual([]);
  });

  it('refuses to boot without a key unless anonymous access is explicit', () => {
    expect(() => staticConfigFromEnv({})).toThrow(/LISTEN_FIRE_API_KEY is required/);
    expect(staticConfigFromEnv({ LISTEN_FIRE_ALLOW_ANONYMOUS: 'true' }).allowAnonymous).toBe(true);
  });

  it('rejects malformed identity settings rather than falling back', () => {
    expect(() => staticConfigFromEnv({ LISTEN_FIRE_API_KEY: 'k', LISTEN_FIRE_ACCESS: 'owner' })).toThrow(
      /LISTEN_FIRE_ACCESS/,
    );
    expect(staticConfigFromEnv({ LISTEN_FIRE_API_KEY: 'k', LISTEN_FIRE_ACCESS: 'write' }).access).toBe('write');
    expect(staticConfigFromEnv({ LISTEN_FIRE_API_KEY: 'k', LISTEN_FIRE_ACCESS: 'admin' }).access).toBe('admin');
    expect(() => staticConfigFromEnv({ LISTEN_FIRE_API_KEY: 'k', LISTEN_FIRE_ALLOW_ANONYMOUS: 'yes' })).toThrow(
      /LISTEN_FIRE_ALLOW_ANONYMOUS/,
    );
    expect(() => staticConfigFromEnv({ LISTEN_FIRE_API_KEY: 'k', LISTEN_FIRE_SCOPES: ' , ' })).toThrow(
      /LISTEN_FIRE_SCOPES/,
    );
  });

  it('seeds the directory with the configured user', () => {
    const parsed = staticConfigFromEnv({
      LISTEN_FIRE_API_KEY: 'k',
      LISTEN_FIRE_TEAM_ID: TEAM,
      LISTEN_FIRE_USER_ID: 'user-1',
      LISTEN_FIRE_USER_EMAIL: 'someone@example.com',
      LISTEN_FIRE_USER_NAME: 'Someone',
      LISTEN_FIRE_SCOPES: 'automation, knowledge',
    });

    expect(parsed.scopes).toEqual(['automation', 'knowledge']);
    expect(parsed.directory).toEqual({
      team: { id: TEAM, name: 'Local' },
      users: [
        { id: 'user-1', email: 'someone@example.com', displayName: 'Someone', hasAccess: true },
      ],
    });
  });
});

describe('the static principal provider', () => {
  it('accepts the configured key as a bearer token or an x-api-key header', async () => {
    const provider = createStaticPrincipalProvider(config());

    const presentations: Record<string, string>[] = [
      { authorization: 'Bearer sekrit' },
      { 'x-api-key': 'sekrit' },
    ];

    for (const headers of presentations) {
      const result = await provider.authenticate(request(headers));
      expect(result).toEqual({
        ok: true,
        principal: {
          teamId: TEAM,
          userId: 'user-1',
          access: 'write',
          scopes: ['*'],
          pinnedTeamId: TEAM,
          credentialId: 'static',
        },
      });
    }
  });

  it('rejects a wrong key and a missing key, advertising the scheme', async () => {
    const provider = createStaticPrincipalProvider(config());

    const wrong = await provider.authenticate(request({ authorization: 'Bearer nope' }));
    expect(wrong).toEqual({
      ok: false,
      status: 401,
      message: 'Invalid API key.',
      wwwAuthenticate: 'Bearer realm="listen-fire"',
    });

    const missing = await provider.authenticate(request());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/Missing API key/);
  });

  it('is not fooled by a key that shares a prefix with the real one', async () => {
    const provider = createStaticPrincipalProvider(config());
    expect((await provider.authenticate(request({ 'x-api-key': 'sekri' }))).ok).toBe(false);
    expect((await provider.authenticate(request({ 'x-api-key': 'sekritt' }))).ok).toBe(false);
  });

  it('admits an unauthenticated request only when anonymous access is configured', async () => {
    const provider = createStaticPrincipalProvider(
      config({ apiKey: undefined, allowAnonymous: true }),
    );
    expect((await provider.authenticate(request())).ok).toBe(true);
    expect((await provider.authenticate(request({ 'x-api-key': 'anything' }))).ok).toBe(true);
  });

  // A browser holds a cookie, never the key. The package is told how to ASK
  // whether one is good — it must not learn what a session token is.
  it('accepts a session cookie the host vouches for, and only that one', async () => {
    const vouched = createStaticPrincipalProvider(config(), {
      session: { cookie: 'listen_fire_token', verify: (value) => value === 'good-session' },
    });

    const accepted = await vouched.authenticate(requestWithCookies({ listen_fire_token: 'good-session' }));
    expect(accepted.ok).toBe(true);

    const refused = await vouched.authenticate(requestWithCookies({ listen_fire_token: 'stale' }));
    expect(refused).toEqual({
      ok: false,
      status: 401,
      message: 'Missing API key: send it as `Authorization: Bearer …` or `x-api-key`.',
      wwwAuthenticate: 'Bearer realm="listen-fire"',
    });
  });

  it('carries the read access level into the principal', async () => {
    const provider = createStaticPrincipalProvider(config({ access: 'read' }));
    const result = await provider.authenticate(request({ 'x-api-key': 'sekrit' }));
    if (!result.ok) throw new Error('expected the configured key to authenticate');

    expect(result.principal.access).toBe('read');
    expect(await provider.listTeams(result.principal)).toEqual([
      { teamId: TEAM, name: 'Local', access: 'read', isPersonal: false },
    ]);
  });

  it('pins every principal to the one team and refuses any other', async () => {
    const provider = createStaticPrincipalProvider(config());
    const result = await provider.authenticate(request({ 'x-api-key': 'sekrit' }));
    if (!result.ok) throw new Error('expected the configured key to authenticate');

    expect(result.principal.pinnedTeamId).toBe(TEAM);
    expect(await provider.resolveTeam(result.principal)).toEqual({
      teamId: TEAM,
      name: 'Local',
      access: 'write',
      isPersonal: false,
    });
    expect(await provider.resolveTeam(result.principal, TEAM)).toEqual({
      teamId: TEAM,
      name: 'Local',
      access: 'write',
      isPersonal: false,
    });
    await expect(provider.resolveTeam(result.principal, 'other-team')).rejects.toBeInstanceOf(
      TeamScopeError,
    );
  });
});
