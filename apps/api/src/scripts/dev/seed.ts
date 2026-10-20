/**
 * Dev-loop seed CLI.
 *
 *   pnpm dev:seed                 → JSON to stdout (default)
 *   pnpm dev:seed --pretty        → human-readable summary
 *   pnpm dev:seed --reset         → wipe team + recreate from scratch
 *
 * Idempotent. Pins the team id to TEST_HARNESS_TEAM_ID so that
 * fake-channels base-url injection (lib/recording.ts) kicks in.
 */
import type { TeamId } from '../../generated/kysely/core/Team';

import { ensureDevLoopTeam, DEV_LOOP_TEAM_NAME } from './_lib';
import { getQb, getKnowledgeQb, getAutomationsQb } from '../../lib/kysely';
import { releaseLlmUsageRunReferences } from '../../lib/llm_usage';

const flags = new Set(process.argv.slice(2));
const PRETTY = flags.has('--pretty');
const RESET = flags.has('--reset');

async function resetTeam() {
  const teamId = process.env.TEST_HARNESS_TEAM_ID as TeamId | undefined;
  if (!teamId) throw new Error('TEST_HARNESS_TEAM_ID not set');

  const kqb = getKnowledgeQb([
    'node_resource',
    'evidence',
    'property',
    'edge',
    'node',
    'edge_type',
    'property_type',
    'node_type',
  ]);
  await kqb.deleteFrom('node_resource').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('evidence').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('property').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('edge').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('node').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('edge_type').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('property_type').where('team_id', '=', teamId).execute();
  await kqb.deleteFrom('node_type').where('team_id', '=', teamId).execute();

  // Clear the team's CONFIG + run history + credentials, but KEEP the pinned
  // identity (team / user / user_email / team_membership).
  // `ensureDevLoopTeam` is idempotent and rebuilds the ontology and Attio
  // credential after a reset. Deleting the team row
  // itself is avoided on purpose: ~65 tables carry an ON DELETE RESTRICT FK to
  // `team`, so a full team delete needs an exhaustive, constantly-rotting
  // ordered teardown. Wiping the re-seedable data is what "reset" actually needs.
  const qb = getQb(['automations.external_service_credentials']);
  const aqb = getAutomationsQb(['trigger_run', 'trigger_event']);

  // Run history first. Everything inside `automations` still cascades off the
  // run (parks, joins, awaits, callbacks); the residual `llm_usage` lines that
  // used to null themselves no longer can (D3/D8), so release them by hand.
  await releaseLlmUsageRunReferences({ teamId });
  await aqb.deleteFrom('trigger_run').where('team_id', '=', teamId).execute();
  await aqb.deleteFrom('trigger_event').where('team_id', '=', teamId).execute();

  // Triggers carry no foreign key to the team (D3), so the reset deletes them
  // itself; leaving them behind would leave the team dispatching.
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();

  await qb.deleteFrom('automations.external_service_credentials as external_service_credentials').where('team_id', '=', teamId).execute();
}

async function main() {
  if (RESET) {
    if (PRETTY) console.error(`Resetting team ${process.env.TEST_HARNESS_TEAM_ID}...`);
    await resetTeam();
  }

  const result = await ensureDevLoopTeam();

  if (PRETTY) {
    const c = result.created;
    console.log(`Dev Loop team ready (${DEV_LOOP_TEAM_NAME})`);
    console.log(`  teamId:  ${result.teamId}`);
    console.log(`  userId:  ${result.userId}`);
    console.log(`  email:   ${result.email}`);
    console.log(`  web:     ${result.webBaseUrl}`);
    console.log(`  token:   ${result.token.slice(0, 20)}…`);
    console.log(
      `  created: team=${c.team} user=${c.user} ontology=${c.ontology} attioCreds=${c.attioCredentials} airtableCreds=${c.airtableCredentials} remoteAdapter=${c.remoteAdapter} currencies=${c.currencies}`,
    );
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
