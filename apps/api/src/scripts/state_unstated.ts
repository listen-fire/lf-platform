/**
 * Give every automation and connection that has no access statement the reach
 * it has today, so turning on the access checks changes nobody's reach. A thing
 * with no statement admits nobody; this states each such thing once, with the
 * lists a creation with no person gets (services/access/no_person.ts). A thing
 * with any statement is never touched, so a second run changes nothing.
 *
 * It runs in the `migrate` one-shot after the schema is migrated and before the
 * api takes traffic (deploy/docker-compose.yml; Render's preDeployCommand), once
 * per deployment. Unlike the deploy check it FAILS the deployment when it cannot
 * finish: a thing left unstated is a thing nobody can reach.
 *
 *   --team <id>   only this team's things
 *   --check       READ-ONLY: count what is unstated, per team, and write nothing
 *
 * Usage:
 *   node build/scripts/state_unstated.js [--team <id>] [--check]
 *   pnpm access:state-unstated [--team <id>] [--check]     # against the dev loop
 *
 * See src/db/backfills/README.md for the operator procedure.
 */

import { Client } from 'pg';

import {
  stateWhatIsUnstated,
  teamHasStatements,
  teamsWithUnstated,
  unstatedIn,
  type StatedThings,
} from '../services/access/state_unstated';

function parseArgs(argv: string[]): { team: string | undefined; check: boolean } {
  const teamAt = argv.indexOf('--team');
  return { team: teamAt === -1 ? undefined : argv[teamAt + 1], check: argv.includes('--check') };
}

/**
 * Say what a run stated. The first run in a team states what existed before
 * statements; on a later run an unstated thing is one a creation path did not
 * state, so it is a warning. "Later" is that the team already had statements
 * (no marker to keep): the first rollout's second pass also warns about what
 * the old api created while the first ran, which is true of it.
 */
function reportStated(teamId: string, stated: StatedThings, firstRun: boolean): void {
  const things = [
    ...stated.automations.map((id) => ({ kind: 'automation', id })),
    ...stated.connections.map((id) => ({ kind: 'connection', id })),
  ];
  for (const { kind, id } of things) {
    console.log(`[state-unstated] team ${teamId}: stated ${kind} ${id}`);
    if (!firstRun) {
      console.warn(
        `[state-unstated] team ${teamId}: ${kind} ${id} had no statement though the team already has statements. After the first run an unstated thing means a creation path did not state it; it was given the reach a creation with no person gets.`,
      );
    }
  }
}

async function stateUnstatedMain(argv: string[]): Promise<void> {
  const { team, check } = parseArgs(argv);
  if (argv.includes('--team') && !team) throw new Error('--team needs a team id');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL must be set');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const teams = team !== undefined ? [team] : await teamsWithUnstated(client);
    let automations = 0;
    let connections = 0;
    for (const teamId of teams) {
      if (check) {
        const unstated = await unstatedIn(client, teamId);
        console.log(
          `${teamId}: ${unstated.automations.length} automation(s) and ${unstated.connections.length} connection(s) unstated`,
        );
        automations += unstated.automations.length;
        connections += unstated.connections.length;
        continue;
      }
      // One team at a time and all or none of it, so a failure leaves whole teams stated, never half of one.
      await client.query('BEGIN');
      try {
        const firstRun = !(await teamHasStatements(client, teamId));
        const stated = await stateWhatIsUnstated(client, teamId);
        await client.query('COMMIT');
        reportStated(teamId, stated, firstRun);
        automations += stated.automations.length;
        connections += stated.connections.length;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    const verb = check ? 'unstated' : 'stated';
    console.log(
      `[state-unstated] ${automations} automation(s) and ${connections} connection(s) ${verb} across ${teams.length} team(s)`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  stateUnstatedMain(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(
        '[state-unstated] failed:',
        err instanceof Error ? err.stack ?? err.message : String(err),
      );
      process.exit(1);
    });
}

export { stateUnstatedMain };
