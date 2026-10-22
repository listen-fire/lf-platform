/**
 * Dev-loop harness for the platform as a cloud lf's movements module, over the
 * dev-loop team's real rows.
 *
 *   DEV_LOOP_PROFILE=agent pnpm dev:lf-movements-verify --save
 *   DEV_LOOP_PROFILE=agent pnpm dev:lf-movements-verify --contract
 *
 * Prerequisites: the agent stack is up (`pnpm dev:loop:agent`) and seeded
 * (`pnpm dev:seed`); `--contract` also needs the loop booted with
 * `LF_ENGINE_TEAMS` naming the dev-loop team, and `LF_BIN` (lf >= 0.12.0-rc.10).
 *
 * `--save` does the setup:
 *   - the dev-loop team's `acme_crm` fake CRM install (its bearer is the
 *     install's own credential; `acme_crm` takes no `using`);
 *   - `lib/greet` and `tick` (a per-minute cron writing a greeting to the CRM)
 *     saved through the real `saveMovement`, both confirmed shipped;
 *   - a scratch lf project in `.dev-loop/lf-movements/project` whose store,
 *     secrets and movements slots are the platform's and whose `acme_crm`
 *     external is the fake CRM, and `lf.env` beside it (mode 0600) holding the
 *     two keys it mints, for `set -a; . lf.env; set +a` before running lf.
 *
 * `--contract` runs the read-only movements module's cases against the loop's
 * real route (bridge c) and against lf's own client of that route
 * (`lf --contract-movements-slot` over the project), with the key from
 * `lf.env`: it mints nothing, so a running `lf serve` keeps working.
 *
 * It prints pass or fail per case, and never a key, a credential field or a
 * movement's text.
 */

import './_profile_loader';
// Register the same service adapters the API server boots, as the other dev
// harnesses do, so a save introspects the fake CRM for real.
import '../../services';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SlotClient, startModule } from 'module-runtime/module_wire/wire';

import { readOnlyModuleCases, isTokenlessCase } from '../../services/lf_movements/__test__/contract_cases';
import { saveMovement } from '../../services/translation_graph/movement/provision';
import { ensureDevLoopRemoteAdapter, ensureDevLoopTeam } from './_lib';
import { FAKE_CRM_ADAPTER_TYPE, fakeCrmBaseUrl } from './fake_crm_adapter';
import { rotateLfMovementsKey } from './lib/lf_movements_key';
import { rotateLfSecretsKey } from './lib/lf_secrets_key';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const WORK_DIR = join(REPO_ROOT, '.dev-loop/lf-movements');
const PROJECT = join(WORK_DIR, 'project');
const ENV_FILE = join(WORK_DIR, 'lf.env');

/** The field the platform's secrets module lists the install's bearer under (the install's own credential, bound to `acme_crm`). */
const CREDENTIAL_BEARER_FIELD = 'secret';

const GREET = 'export function greet(name: <text>) {\n  return "Hello, ${name}!"\n}\n';

const TICK = `import { acme_crm } from adapters
import { greet } from "lib/greet"
crm = connect acme_crm
function tock(t: <cron-[:Tick]->>) {
  write crm-[:Company]-> { Name: greet("\${t.\`Fired at\`}") }
}
listen to cron { schedule: "* * * * *" } fire tock
`;

const MIN_LF = { minor: 12, rc: 10 };

function lfBinary(): string {
  const bin = process.env.LF_BIN ?? 'lf';
  const reported = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  const match = /(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/.exec(reported);
  const older = match === null || Number(match[2]) < MIN_LF.minor || (Number(match[2]) === MIN_LF.minor && match[4] !== undefined && Number(match[4]) < MIN_LF.rc);
  if (older) throw new Error(`lf >= 0.12.0-rc.10 is required (the movements slot's contract flag); ${bin} reports "${reported}"`);
  return bin;
}

function apiBase(): string {
  const base = process.env.API_BASE_URL;
  if (base === undefined || base === '') throw new Error('API_BASE_URL is not set: boot the agent stack (pnpm dev:loop:agent) and run with DEV_LOOP_PROFILE=agent');
  return base.replace(/\/$/, '');
}

function writeFileIn(root: string, path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

async function ship(teamId: string, name: string, source: string): Promise<void> {
  const saved = await saveMovement({ teamId, source, name });
  if (!saved.ok) throw new Error(`${name} did not ship: ${saved.needsConfirmation ? 'needs confirmation: ' : ''}${(saved.errors ?? []).join('; ')}`);
  console.log(`[lf-movements-verify] shipped ${name}`);
}

async function save(): Promise<void> {
  const base = apiBase();
  const seed = await ensureDevLoopTeam();
  await ensureDevLoopRemoteAdapter({ teamId: seed.teamId, userId: seed.userId });
  await ship(seed.teamId, 'lib/greet', GREET);
  await ship(seed.teamId, 'tick', TICK);

  const movementsKey = await rotateLfMovementsKey({ teamId: seed.teamId, userId: seed.userId });
  const secretsKey = await rotateLfSecretsKey({ teamId: seed.teamId, userId: seed.userId });

  writeFileIn(PROJECT, 'lf.yaml', 'engine: 0.12.0\ncore:\n  store: platform_store\n  secrets: platform_secrets\n  movements: platform_movements\n');
  for (const [name, slot] of [['platform_store', 'store'], ['platform_movements', 'movements']] as const) {
    writeFileIn(PROJECT, `externals/${name}/lf-external.yaml`, `name: ${name}\nkind: core\nslot: ${slot}\nurl: ${base}/api/v1/system/slots/${slot}\nauth: { kind: bearer, field: key }\n`);
  }
  writeFileIn(
    PROJECT,
    'externals/platform_secrets/lf-external.yaml',
    [
      'name: platform_secrets',
      'kind: core',
      'slot: secrets',
      `url: ${base}/api/public/lf-secrets`,
      'auth: { kind: bearer, field: token }',
      'settings:',
      '  - { name: team, label: the platform team whose credentials lf keeps }',
      '',
    ].join('\n'),
  );
  writeFileIn(
    PROJECT,
    `externals/${FAKE_CRM_ADAPTER_TYPE}/lf-external.yaml`,
    `name: ${FAKE_CRM_ADAPTER_TYPE}\nkind: adapter\nprotocol: 2\nurl: ${fakeCrmBaseUrl()}\nauth: { kind: bearer, field: ${CREDENTIAL_BEARER_FIELD} }\n`,
  );

  const env = [
    'LF_SECRET__PLATFORM_STORE__EXTERNAL=platform_store',
    `LF_SECRET__PLATFORM_STORE__KEY=${movementsKey}`,
    'LF_SECRET__PLATFORM_MOVEMENTS__EXTERNAL=platform_movements',
    `LF_SECRET__PLATFORM_MOVEMENTS__KEY=${movementsKey}`,
    'LF_SECRET__PLATFORM_SECRETS__EXTERNAL=platform_secrets',
    `LF_SECRET__PLATFORM_SECRETS__TOKEN=${secretsKey}`,
    `LF_SECRET__PLATFORM_SECRETS__TEAM=${seed.teamId}`,
    '',
  ].join('\n');
  writeFileSync(ENV_FILE, env, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);

  console.log(`[lf-movements-verify] team ${seed.teamId}`);
  console.log(`[lf-movements-verify] project ${PROJECT}`);
  console.log(`[lf-movements-verify] env in ${ENV_FILE} (mode 0600):`);
  for (const line of env.split('\n').filter((entry) => entry !== '')) console.log(`  ${line.replace(/(KEY|TOKEN)=.*/, '$1=<elided>')}`);
}

/** The project's settings, as `--save` wrote them: what lf is started with. */
function projectEnv(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

const results = { pass: 0, fail: 0 };

/** A failure names the case and the error's kind; an assertion's values are withheld because they may be movement text. */
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    results.pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    results.fail += 1;
    const detail = error instanceof assert.AssertionError ? 'assertion failed (values withheld)' : error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    console.log(`FAIL ${name} - ${detail}`);
  }
}

async function contract(): Promise<void> {
  const route = `${apiBase()}/api/v1/system/slots/movements`;
  const settings = projectEnv();
  const key = settings.LF_SECRET__PLATFORM_MOVEMENTS__KEY;
  if (key === undefined) throw new Error(`the movements key is not in ${ENV_FILE}: run --save first`);
  const lf = lfBinary();

  for (const slotCase of readOnlyModuleCases()) {
    if (isTokenlessCase(slotCase)) continue;
    await check(`the real route: ${slotCase.name}`, () => slotCase.run(new SlotClient({ baseUrl: route, token: key })));
  }

  const started = await startModule(lf, ['--contract-movements-slot', '--dir', PROJECT], {
    env: settings,
  });
  try {
    for (const slotCase of readOnlyModuleCases()) {
      await check(`lf's client of the route: ${slotCase.name}`, () => slotCase.run(new SlotClient(started.address)));
    }
  } finally {
    await started.close();
  }
  console.log(`[lf-movements-verify] ${results.pass} passed, ${results.fail} failed`);
  if (results.fail > 0) process.exitCode = 1;
}

const mode = process.argv[2];
(mode === '--save' ? save() : mode === '--contract' ? contract() : Promise.reject(new Error('usage: dev:lf-movements-verify --save | --contract')))
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
    process.exit(1);
  });
