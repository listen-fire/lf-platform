// Which teams the deployment hands to lf: LF_ENGINE_TEAMS, read off the
// environment and refused at boot when an entry is not a team id.

import { assertLfEngineTeamsConfigured, isLfEngineTeam, lfEngineTeams } from '../teams';

const A = '6f1c2a1e-0b7a-4c55-9a3e-1f0d2b3c4d5e';
const B = '00000000-0000-0000-0000-00000000000b';

describe('LF_ENGINE_TEAMS', () => {
  it('names no team when unset or empty', () => {
    expect([...lfEngineTeams({})]).toEqual([]);
    expect([...lfEngineTeams({ LF_ENGINE_TEAMS: '' })]).toEqual([]);
    expect([...lfEngineTeams({ LF_ENGINE_TEAMS: ' , ,' })]).toEqual([]);
    expect(isLfEngineTeam(A, {})).toBe(false);
    expect(() => assertLfEngineTeamsConfigured({})).not.toThrow();
  });

  it('reads a comma-separated list, trimming each entry', () => {
    const env = { LF_ENGINE_TEAMS: ` ${A} ,${B},, ` };
    expect([...lfEngineTeams(env)].sort()).toEqual([A, B].sort());
    expect(isLfEngineTeam(A, env)).toBe(true);
    expect(isLfEngineTeam(B, env)).toBe(true);
    expect(isLfEngineTeam('11111111-1111-1111-1111-111111111111', env)).toBe(false);
    expect(() => assertLfEngineTeamsConfigured(env)).not.toThrow();
  });

  it('refuses an entry that is not a team id, naming the variable', () => {
    for (const value of ['acme', `${A},not-a-guid`, `${A};${B}`]) {
      expect(() => lfEngineTeams({ LF_ENGINE_TEAMS: value })).toThrow(/LF_ENGINE_TEAMS/);
      expect(() => assertLfEngineTeamsConfigured({ LF_ENGINE_TEAMS: value })).toThrow(/LF_ENGINE_TEAMS/);
    }
  });

  it('follows the environment when the variable changes', () => {
    const env: Record<string, string | undefined> = { LF_ENGINE_TEAMS: A };
    expect(isLfEngineTeam(A, env)).toBe(true);
    env.LF_ENGINE_TEAMS = B;
    expect(isLfEngineTeam(A, env)).toBe(false);
    expect(isLfEngineTeam(B, env)).toBe(true);
  });
});
