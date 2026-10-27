// MCP servers on the platform, end to end: one team connects two MCP servers
// (an issue tracker signed in with a bearer token, a CRM with its own header),
// each stored as an MCP credential. Nothing is mocked. The team catalog
// describes each connection through the module loaded in process, so each is
// typed by its own server's tools; the real save refuses a write whose
// argument has the wrong type, and one that uses the other server's tool; a
// saved, release-pinned movement fires through the manual door and the
// dispatch path, and its writes and its read reach the servers. Every request
// goes through the platform's public-address fetch (the fake servers are on
// localhost, which the harness's development environment allows), and counts
// against the run's ceiling on calls to remote systems.

import { randomUUID } from 'node:crypto';

jest.mock('../../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import ExternalServiceType from '../../../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import { persistCredential } from '../../../../credentials/persist_credential';
import { movementCatalogForTeam } from '../../../movement/catalog';
import { saveMovement } from '../../../movement/provision';
import { runMovementNow } from '../../../movement/run_now';
import { startFakeMcpServer, type FakeMcpServer } from '../../../../../scripts/dev/lib/fake_mcp';

const TRIAGE = `import { manual, mcp } from adapters
import { linear, crm } from credentials

go = connect manual
tracker = connect mcp using linear
customers = connect mcp using crm

function triage(run: <go-[:Invocation]->>) {
  issue = write tracker-[:create_issue]-> { title: "Follow up Acme", team: "ENG" }
  write customers-[:add_note]-> { customer: "acme", body: "filed: \${issue.text}" }
  tracker-[r:search_issues WHERE r.query == "Login"]-> {
    write customers-[:add_note]-> { customer: "acme", body: "open: \${r.count} \${r.titles}" }
  }
}

listen to go {} fire triage
`;

let issues: FakeMcpServer;
let customers: FakeMcpServer;
let teamId: TeamId;

async function connect(name: string, credentials: Record<string, string>): Promise<void> {
  await persistCredential({ teamId, userId: null, name, type: ExternalServiceType.MCP, credentials });
}

beforeAll(async () => {
  issues = await startFakeMcpServer({ kind: 'issues', token: 'issues-token' });
  customers = await startFakeMcpServer({ kind: 'crm', token: 'crm-key', header: 'X-API-Key' });
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `mcp-host-${teamId.slice(0, 8)}` } as any)
    .execute();
  await connect('linear', { url: issues.url, token: 'issues-token' });
  await connect('crm', { url: customers.url, token: 'crm-key', header: 'X-API-Key' });
  // A connection naming the cloud metadata address: https, so it is stored,
  // but no request is ever made to it.
  await connect('metadata', { url: 'https://169.254.169.254/mcp', token: 'stolen' });
}, 60_000);

afterAll(async () => {
  await cleanupTeam(teamId);
  await issues.close();
  await customers.close();
});

it('types each MCP connection by its own server’s tools', async () => {
  const catalog = await movementCatalogForTeam(teamId, { source: TRIAGE });

  const schemaOf = (credentialName: string) => catalog.instanceSchemas.find((entry) => entry.adapter === 'mcp' && entry.credentialName === credentialName)?.schema;
  const tracker = schemaOf('linear');
  const crm = schemaOf('crm');
  expect(catalog.gaps).toEqual([]);
  expect(Object.keys(tracker?.writableRoots ?? {}).sort()).toEqual(['create_issue']);
  expect(tracker?.writableRoots.create_issue?.fields).toMatchObject({ title: 'text', priority: 'number' });
  expect(tracker?.positions.search_issues?.properties).toMatchObject({ query: 'text', count: 'number' });
  expect(Object.keys(crm?.writableRoots ?? {}).sort()).toEqual(['add_note']);
  // Each connection has its own server's tools, and none of the other's.
  const TOOLS = ['add_note', 'create_issue', 'find_customer', 'search_issues'];
  const toolsOf = (schema: typeof tracker) =>
    TOOLS.filter((tool) => schema !== undefined && (tool in schema.positions || tool in schema.writableRoots));
  expect(toolsOf(tracker)).toEqual(['create_issue', 'search_issues']);
  expect(toolsOf(crm)).toEqual(['add_note', 'find_customer']);
});

it('refuses at save a write whose argument has the wrong type, and a tool of the other server', async () => {
  const wrongType = await saveMovement({ teamId, source: TRIAGE.replace('team: "ENG" }', 'team: "ENG", priority: "high" }') });
  expect(wrongType.ok).toBe(false);
  expect(wrongType.ok === false && wrongType.needsConfirmation).toBe(true);
  expect(wrongType.ok === false ? wrongType.errors : []).toEqual([expect.stringMatching(/'priority' on tracker\.create_issue is number, but this expression produces text/)]);

  const otherServer = await saveMovement({
    teamId,
    source: TRIAGE.replace('write customers-[:add_note]-> { customer: "acme", body: "filed', 'write customers-[:create_issue]-> { customer: "acme", body: "filed'),
  });
  expect(otherServer.ok).toBe(false);
  expect(otherServer.ok === false ? (otherServer.errors ?? []).join('\n') : '').toMatch(/create_issue/);
});

it('refuses a connection whose server is not at a public address before any request', async () => {
  const catalog = await movementCatalogForTeam(teamId, {
    source: `import { mcp } from adapters
import { metadata } from credentials
probe = connect mcp using metadata
`,
  });
  expect(catalog.gaps.map((gap) => gap.detail).join('\n')).toBe('MCP server https://169.254.169.254/mcp: 169.254.169.254 is not a public address, so it is not reached.');
});

it('runs a saved, release-pinned movement through the platform: writes call the tools, the result and a read are readable', async () => {
  const saved = await saveMovement({ teamId, source: TRIAGE });
  if (!saved.ok) throw new Error(`save refused: ${(saved.errors ?? []).join('; ')}`);
  const row = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where('team_id', '=', teamId)
    .where('name', '=', 'triage')
    .select(['id', 'language_version'])
    .executeTakeFirstOrThrow();
  expect(row.language_version).toBe(LANGUAGE_VERSION);

  issues.calls.length = 0;
  customers.calls.length = 0;
  const run = await runMovementNow({ teamId, movementId: saved.movementId });
  if (!run.ok) throw new Error(`run failed: ${run.errors.join('; ')}`);

  expect(run).toMatchObject({ ok: true, movementName: 'triage', dryRun: false, recordCount: 3 });
  expect(issues.calls).toEqual([
    { tool: 'create_issue', args: { title: 'Follow up Acme', team: 'ENG' } },
    { tool: 'search_issues', args: { query: 'Login' } },
  ]);
  expect(customers.calls).toEqual([
    { tool: 'add_note', args: { customer: 'acme', body: 'filed: created ENG-2: Follow up Acme' } },
    { tool: 'add_note', args: { customer: 'acme', body: expect.stringMatching(/^open: 1 /) } },
  ]);

  // Each request to a server counts against the run's ceiling on calls to
  // remote systems: held to 2, the run stops at the first tool call.
  const ceiling = process.env.REMOTE_ADAPTER_MAX_CALLS_PER_RUN;
  process.env.REMOTE_ADAPTER_MAX_CALLS_PER_RUN = '2';
  try {
    const stopped = await runMovementNow({ teamId, movementId: saved.movementId });
    expect(stopped.ok === false ? stopped.errors.join('\n') : JSON.stringify(stopped)).toMatch(/Remote adapter call ceiling reached: this run made 2 Remote adapter API calls/);
  } finally {
    if (ceiling === undefined) delete process.env.REMOTE_ADAPTER_MAX_CALLS_PER_RUN;
    else process.env.REMOTE_ADAPTER_MAX_CALLS_PER_RUN = ceiling;
  }
}, 120_000);
