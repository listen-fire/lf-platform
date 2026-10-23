// Dispatch's copy of the lf-engined teams: what makes "no query per firing"
// true. The table is faked; the test counts the reads it receives.

let lfTeams: string[] = [];
let reads = 0;
let release: (() => void) | undefined;
let holdReads = false;

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => ({
      where: () => ({
        select: () => ({
          execute: async () => {
            reads += 1;
            const answer = lfTeams.map((team_id) => ({ team_id }));
            if (holdReads) await new Promise<void>((resolve) => (release = resolve));
            return answer;
          },
        }),
      }),
    }),
  }),
}));

import { assertLfEngineTeamsRetired, forgetLfEngineTeams, isLfEngineTeam, LF_ENGINE_COPY_LIFETIME_MS } from '../team_engine';

const A = '6f1c1c7e-7d6a-4c52-9a43-0d4b2c2f8a11';
const B = '0b8e5c0e-2b1f-4f1e-8d0a-6a3c1e9d7b22';

let now = 1_000_000;

beforeEach(() => {
  forgetLfEngineTeams();
  reads = 0;
  lfTeams = [];
  holdReads = false;
  release = undefined;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => jest.restoreAllMocks());

describe("dispatch's copy of the lf-engined teams", () => {
  it('reads the table once per lifetime, however many firings ask', async () => {
    lfTeams = [A];
    expect(await isLfEngineTeam(A)).toBe(true);
    expect(await isLfEngineTeam(B)).toBe(false);
    now += LF_ENGINE_COPY_LIFETIME_MS - 1;
    expect(await isLfEngineTeam(A)).toBe(true);
    expect(reads).toBe(1);

    lfTeams = [B];
    now += 1;
    expect(await isLfEngineTeam(A)).toBe(false);
    expect(await isLfEngineTeam(B)).toBe(true);
    expect(reads).toBe(2);
  });

  it('shares one read among concurrent firings', async () => {
    lfTeams = [A];
    const answers = await Promise.all([isLfEngineTeam(A), isLfEngineTeam(A), isLfEngineTeam(B)]);
    expect(answers).toEqual([true, true, false]);
    expect(reads).toBe(1);
  });

  it('a forget (a switch in this process) is seen by the next firing', async () => {
    expect(await isLfEngineTeam(A)).toBe(false);
    lfTeams = [A];
    forgetLfEngineTeams();
    expect(await isLfEngineTeam(A)).toBe(true);
    expect(reads).toBe(2);
  });

  it('a read that began before a forget is not kept as the copy', async () => {
    holdReads = true;
    const early = isLfEngineTeam(A);
    await new Promise((resolve) => setImmediate(resolve));
    lfTeams = [A];
    forgetLfEngineTeams();
    release?.();
    expect(await early).toBe(false);

    holdReads = false;
    expect(await isLfEngineTeam(A)).toBe(true);
    expect(reads).toBe(2);
  });
});

describe('the retired LF_ENGINE_TEAMS', () => {
  it('boots when unset or empty, and refuses naming the variable and the remedy when set', () => {
    expect(() => assertLfEngineTeamsRetired({})).not.toThrow();
    expect(() => assertLfEngineTeamsRetired({ LF_ENGINE_TEAMS: ' ' })).not.toThrow();
    expect(() => assertLfEngineTeamsRetired({ LF_ENGINE_TEAMS: A })).toThrow(/LF_ENGINE_TEAMS is retired.*team-engine --team <id> --set lf/);
  });
});
