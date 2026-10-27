/**
 * Dev-loop CLI for MCP servers on the platform (`@lf/mcp`).
 *
 *   pnpm dev:mcp serve [--port 4790]     # a fake MCP issue tracker, until stopped
 *   pnpm dev:mcp connect --url <url>     # connect it for the dev-loop team,
 *                                        # through the connect link's key-entry form
 *   pnpm dev:mcp setup                   # save the probe movement
 *   pnpm dev:movement run mcp_probe      # fire it
 *
 * `connect` mints the connect link the agent's connectSystem mints, then
 * submits the form its landing page renders to the running API, exactly as a
 * person pasting the URL and token would; the credential is stored by the
 * platform's own submit route. `serve` logs every tool call it is sent, so the
 * run's calls can be read off its output.
 */

import './_profile_loader';
// Register the service adapters the API server boots, so `saveMovement` runs
// the real provision path.
import '../../services';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb } from '../../lib/kysely';
import { mintConnectLink } from '../../services/credentials/connect_link';
import { saveMovement } from '../../services/translation_graph/movement/provision';
import { ensureDevLoopTeam } from './_lib';
import { startFakeMcpServer } from './lib/fake_mcp';

const TOKEN = process.env.DEV_MCP_TOKEN ?? 'dev-mcp-token';
const CREDENTIAL = 'Dev Loop MCP';

const PROBE = `import { manual, mcp } from adapters
import { \`${CREDENTIAL}\` } from credentials

go = connect manual
tracker = connect mcp using \`${CREDENTIAL}\`

function mcp_probe(run: <go-[:Invocation]->>) {
  issue = write tracker-[:create_issue]-> { title: "Dev loop probe", team: "ENG" }
  tracker-[r:search_issues WHERE r.query == "probe"]-> {
    write tracker-[:create_issue]-> { title: "seen \${r.count}: \${issue.text}", team: "OPS" }
  }
}

listen to go {} fire mcp_probe
`;

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

async function serve(port: number): Promise<void> {
  const fake = await startFakeMcpServer({ kind: 'issues', token: TOKEN, port });
  console.log(`fake MCP server (issues) at ${fake.url}, token ${TOKEN}`);
  let seen = 0;
  setInterval(() => {
    for (const call of fake.calls.slice(seen)) console.log(`tool call ${call.tool} ${JSON.stringify(call.args)}`);
    seen = fake.calls.length;
  }, 200);
}

async function connect(url: string): Promise<void> {
  const seed = await ensureDevLoopTeam();
  const link = await mintConnectLink({
    teamId: seed.teamId as TeamId,
    userId: seed.userId as UserId,
    adapterSlug: 'mcp',
    credentialName: CREDENTIAL,
  });
  if ('error' in link) throw new Error(link.error);
  console.log(`connect link (${link.connectKind}) for ${link.displayName}: ${link.url}`);
  const landing = await fetch(link.url);
  console.log(`GET landing: HTTP ${landing.status}`);
  const submitted = await fetch(link.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url, token: TOKEN, header: '' }).toString(),
  });
  const page = await submitted.text();
  console.log(`POST form: HTTP ${submitted.status} ${/<h1>([^<]*)<\/h1>/.exec(page)?.[1] ?? ''}`);
  const rows = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', seed.teamId as TeamId)
    .where('type', '=', ExternalServiceType.MCP)
    .select(['name', 'type'])
    .execute();
  console.log(`MCP credentials of the dev-loop team: ${JSON.stringify(rows)}`);
}

async function setup(): Promise<void> {
  const seed = await ensureDevLoopTeam();
  const saved = await saveMovement({ teamId: seed.teamId, source: PROBE });
  console.log(JSON.stringify(saved.ok ? { ok: true, movementId: saved.movementId, validity: saved.validity.status } : saved, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  switch (command) {
    case 'serve':
      return serve(Number(flagValue(args, 'port') ?? 4790));
    case 'connect': {
      const url = flagValue(args, 'url');
      if (url === undefined) throw new Error('connect needs --url <the server URL>');
      await connect(url);
      process.exit(0);
      return;
    }
    case 'setup':
      await setup();
      process.exit(0);
      return;
    default:
      console.error(`Unknown command '${command ?? ''}'. Use: serve [--port N] | connect --url <url> | setup`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
