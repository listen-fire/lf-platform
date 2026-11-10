/**
 * List every automation whose listens mix who may fire through them: some hear
 * only the team (Slack, a shared WhatsApp number), some hear anyone. The backfill
 * that states what already existed gave each such file the narrower list, so
 * nothing widened; this is how a person finds them to widen by hand.
 *
 * Read-only: it changes nothing. A team whose automations run on lf is left out:
 * the platform judges no fire list there, and its files are stated anyone.
 *
 *   --team <id>   only this team's automations
 *   --json        machine-readable
 *
 * Usage:
 *   node build/scripts/list_mixed_fire_reach.js [--team <id>] [--json]
 *   pnpm access:mixed-fire-reach [--team <id>] [--json]     # against the dev loop
 */

import { Client } from 'pg';

import { firedTodayBy } from '../services/access/no_person';
import { listensOf, teamRunsOnLf } from '../services/access/state_unstated';

type MixedFile = {
  teamId: string;
  automationId: string;
  name: string;
  /** Each listen with who may fire through it today. */
  listens: { module: string; viaConnection: boolean; firedBy: 'team' | 'anyone' }[];
  /** The fire list it has now, as stated. */
  fireList: string[];
};

function describeGrantee(row: { grantee: string; value: string | null }): string {
  return row.value === null ? row.grantee : `${row.grantee}:${row.value}`;
}

function parseArgs(argv: string[]): { team: string | undefined; json: boolean } {
  const teamAt = argv.indexOf('--team');
  return { team: teamAt === -1 ? undefined : argv[teamAt + 1], json: argv.includes('--json') };
}

async function mixedFilesOf(client: Client, teamId: string): Promise<MixedFile[]> {
  if (await teamRunsOnLf(client, teamId)) return [];
  const automations = await client.query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM automations.movement WHERE team_id = $1::uuid ORDER BY name, id`,
    [teamId],
  );
  const listens = await listensOf(
    client,
    teamId,
    automations.rows.map((a) => a.id),
  );
  const mixed: MixedFile[] = [];
  for (const automation of automations.rows) {
    const reaches = (listens.get(automation.id) ?? []).map((listen) => ({
      ...listen,
      firedBy: firedTodayBy(listen),
    }));
    if (!(reaches.some((r) => r.firedBy === 'team') && reaches.some((r) => r.firedBy === 'anyone')))
      continue;
    const fire = await client.query<{ grantee: string; value: string | null }>(
      `SELECT grantee, value FROM automations.access_statement
        WHERE thing = 'automation' AND thing_id = $1::uuid AND verb = 'fire' ORDER BY grantee, value`,
      [automation.id],
    );
    mixed.push({
      teamId,
      automationId: automation.id,
      name: automation.name,
      listens: reaches,
      fireList: fire.rows.map(describeGrantee),
    });
  }
  return mixed;
}

function render(files: readonly MixedFile[]): string {
  if (files.length === 0)
    return 'No automation mixes listens that admit the team with listens that admit anyone.';
  return files
    .map((file) => {
      const heard = file.listens
        .map(
          (l) =>
            `    ${l.module}${l.viaConnection ? ' (via a connection)' : ''}: fired by ${l.firedBy}`,
        )
        .join('\n');
      return `${file.name}  [team ${file.teamId}, automation ${file.automationId}]\n  fire list now: ${file.fireList.join(', ') || 'none stated'}\n${heard}`;
    })
    .join('\n\n');
}

async function listMixedFireReachMain(argv: string[]): Promise<void> {
  const { team, json } = parseArgs(argv);
  if (argv.includes('--team') && !team) throw new Error('--team needs a team id');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL must be set');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const teams =
      team !== undefined
        ? [team]
        : (
            await client.query<{ team_id: string }>(
              `SELECT DISTINCT team_id::text AS team_id FROM automations.movement ORDER BY 1`,
            )
          ).rows.map((r) => r.team_id);
    const files: MixedFile[] = [];
    for (const teamId of teams) files.push(...(await mixedFilesOf(client, teamId)));
    console.log(json ? JSON.stringify(files, null, 2) : render(files));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  listMixedFireReachMain(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(
        '[mixed-fire-reach] failed:',
        err instanceof Error ? err.stack ?? err.message : String(err),
      );
      process.exit(1);
    });
}

export { mixedFilesOf, render, listMixedFireReachMain, type MixedFile };
