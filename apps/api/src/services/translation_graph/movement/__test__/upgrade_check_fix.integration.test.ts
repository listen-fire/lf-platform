// A stored upgrade check keeps each diagnostic's fix edits, so the web panel
// can show the proposed change from the record alone; a fault inside a library
// is stored without them (its fix could carry the library's own lines).

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import type { AuthoringDiagnostic } from '../authoring';
import { getMovementRow, pendingUpgradeDiagnostics, recordUpgradeCheck } from '../store';

const withFix = (over: Partial<AuthoringDiagnostic>): AuthoringDiagnostic => ({
  code: 'MOV_LISTEN_NOW_OPEN',
  message: 'this listen is open to everyone in the channel now',
  severity: 'error',
  line: 7,
  col: 1,
  endLine: 7,
  endCol: 60,
  sourceLine: 'listen to slack-[m:Messages]-> fire intake',
  fix: { edits: [{ line: 7, col: 40, endLine: 7, endCol: 40, text: ' AND team.isMember(m.`User Email`)' }] },
  ...over,
});

describe('recordUpgradeCheck (real Postgres)', () => {
  let teamId: TeamId;
  let id: MovementId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    id = randomUUID() as MovementId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `upgrade-fix-${teamId.slice(0, 8)}` }).execute();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id, team_id: teamId, name: 'deals', source: '', description: '', language_version: '0.15.3' })
      .execute();
  });

  afterEach(async () => {
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
  });

  it('keeps the fix edits of a diagnostic the web panel will show', async () => {
    const found = withFix({});
    await recordUpgradeCheck({ id, diagnostics: [found], checkedAgainst: LANGUAGE_VERSION });

    const row = await getMovementRow({ teamId, id });
    expect(row).not.toBeNull();
    expect(pendingUpgradeDiagnostics(row!)).toEqual([found]);
  });

  it('stores a fault inside a library without its fix', async () => {
    const inLibrary = withFix({ message: '"helpers" line 3: nosuch is not defined' });
    await recordUpgradeCheck({ id, diagnostics: [inLibrary], checkedAgainst: LANGUAGE_VERSION });

    const stored = pendingUpgradeDiagnostics((await getMovementRow({ teamId, id }))!);
    expect(stored).toHaveLength(1);
    expect(stored![0]).not.toHaveProperty('fix');
    expect(JSON.stringify(stored)).not.toContain('nosuch');
  });
});
