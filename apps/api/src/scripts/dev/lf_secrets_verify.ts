/**
 * Dev-loop e2e harness for the platform as listen-fire's secrets module, through listen-fire's
 * own client of it.
 *
 *   DEV_LOOP_PROFILE=agent pnpm dev:lf-secrets-verify
 *
 * Prerequisites: the agent stack is up (`pnpm dev:loop:agent`) and seeded
 * (`pnpm dev:seed`), and listen-fire >= 0.12.0-rc.9 is `LF_BIN` or on PATH. A key's
 * plaintext exists only at mint, so this mints its own, as
 * `pnpm dev:lf-secrets-key` does (set `LF_SECRETS_KEY` to use one you hold).
 *
 * What it proves:
 *   1. listen-fire, told by a temporary project that its secrets slot is the platform's
 *      door, serves the slot's common and secrets cases and the family's eleven
 *      contract cases from that door's rows (`listen-fire --contract-secrets-slot`);
 *   2. two listen-fire processes refreshing one stale OAuth credential together make one
 *      token call, both read the new token, and the platform's row holds it.
 *
 * It prints pass or fail per case, and never the key or a credential field.
 */

import './_profile_loader';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SECRETS_METHODS } from 'engine-contracts/slots';
import { SecretsSlotBackend, SlotClient, commonSlotCases, secretsSlotCases, startModule, type SlotAddress } from 'movement-engine/public/module-wire';
import { createSecretsFamily, oauth2Refresher } from 'movement-engine/public/secrets';
import { secretsContractCases, startFakeOAuthServer, type SecretsContractBackend } from 'movement-engine/public/secrets-testing';

import { ensureDevLoopTeam } from './_lib';
import { rotateLfSecretsKey } from './lib/lf_secrets_key';

const MIN_LF = { minor: 12, rc: 9 };

function lfBinary(): string {
  const bin = process.env.LF_BIN ?? 'listen-fire';
  const reported = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  const match = /(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/.exec(reported);
  const older = match === null || Number(match[2]) < MIN_LF.minor || (Number(match[2]) === MIN_LF.minor && match[4] !== undefined && Number(match[4]) < MIN_LF.rc);
  if (older) throw new Error(`listen-fire >= 0.12.0-rc.9 is required (the secrets slot's contract flag); ${bin} reports "${reported}"`);
  return bin;
}

/** A project whose secrets slot is the platform's door; the settings reach listen-fire through the environment, as the bootstrap rule has it. */
function writeProject(doorUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-secrets-verify-'));
  mkdirSync(join(dir, 'externals/platform_secrets'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/platform_secrets/lf-external.yaml'),
    [
      'name: platform_secrets',
      'kind: core',
      'slot: secrets',
      `url: ${doorUrl}`,
      'auth: { kind: bearer, field: token }',
      'settings:',
      '  - { name: team, label: the platform team whose credentials listen-fire keeps }',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.12.0\ncore:\n  secrets: platform_secrets\n');
  return dir;
}

interface Runner {
  address: SlotAddress;
  close(): Promise<void>;
}

const results = { pass: 0, fail: 0 };

/** A failure names the case and the error's kind; an assertion's values are withheld because they may be credential fields. */
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

async function main(): Promise<void> {
  const apiBase = process.env.API_BASE_URL;
  if (apiBase === undefined || apiBase === '') throw new Error('API_BASE_URL is not set: boot the agent stack (pnpm dev:loop:agent) and run with DEV_LOOP_PROFILE=agent');
  const doorUrl = `${apiBase.replace(/\/$/, '')}/api/public/lf-secrets`;
  const lf = lfBinary();

  const seed = await ensureDevLoopTeam();
  const key = process.env.LF_SECRETS_KEY ?? (await rotateLfSecretsKey({ teamId: seed.teamId, userId: seed.userId }));
  const project = writeProject(doorUrl);
  const door = new SlotClient({ baseUrl: doorUrl, token: key }, { team: seed.teamId });
  const entries = async () => new Set(((await door.call('secrets.list', {})) as Array<{ ref: string }>).map((entry) => entry.ref));
  const before = await entries();

  const runners: Runner[] = [];
  const startRunner = async (): Promise<Runner> => {
    const served = await startModule(lf, ['--contract-secrets-slot', '--dir', project], {
      env: { LF_SECRET__PLATFORM_SECRETS__EXTERNAL: 'platform_secrets', LF_SECRET__PLATFORM_SECRETS__TOKEN: key, LF_SECRET__PLATFORM_SECRETS__TEAM: seed.teamId },
    });
    runners.push(served);
    return served;
  };
  const withRunner = async (body: (runner: Runner) => Promise<void>) => {
    const runner = await startRunner();
    try {
      await body(runner);
    } finally {
      await runner.close();
      runners.splice(runners.indexOf(runner), 1);
    }
  };

  try {
    for (const conformance of commonSlotCases('secrets', SECRETS_METHODS)) {
      await check(`listen-fire's client: ${conformance.name}`, () => withRunner((runner) => conformance.run(new SlotClient(runner.address, {}))));
    }
    for (const conformance of secretsSlotCases) {
      await check(`listen-fire's client: ${conformance.name}`, () => withRunner((runner) => conformance.run(new SlotClient(runner.address, {}))));
    }
    for (const contractCase of secretsContractCases) {
      await check(`listen-fire's client, as a store: ${contractCase.name}`, () =>
        withRunner(async (runner) => {
          const handle = () => new SecretsSlotBackend(runner.address, {});
          const backend: SecretsContractBackend = {
            backend: handle(),
            sibling: handle,
            seed: async (fields) => {
              const ref = `c${randomUUID().replaceAll('-', '').slice(0, 12)}`;
              await handle().seed(ref, 'acme_crm', fields);
              return ref;
            },
            missingRef: () => `missing_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
          };
          await contractCase.run(backend);
        }),
      );
    }

    await check('two listen-fire processes refreshing one stale OAuth credential make one token call and both read the new token', async () => {
      const provider = await startFakeOAuthServer({ clientId: 'verify-client', clientSecret: 'verify-client-secret' });
      const [one, two] = [await startRunner(), await startRunner()];
      try {
        // The provider honours only a refresh token it issued, so take one through its code grant.
        const redirectUri = 'http://127.0.0.1/callback';
        const authorize = await fetch(`${provider.authorizeUrl}?${new URLSearchParams({ client_id: 'verify-client', response_type: 'code', redirect_uri: redirectUri, state: 's' })}`, { redirect: 'manual' });
        const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code') ?? '';
        const exchanged = (await (
          await fetch(provider.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from('verify-client:verify-client-secret').toString('base64')}` },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
          })
        ).json()) as { access_token: string; refresh_token: string };

        const ref = `r${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        await new SecretsSlotBackend(one.address, {}).seed(ref, 'acme_crm', {
          access_token: exchanged.access_token,
          refresh_token: exchanged.refresh_token,
          expires_at: '2000-01-01T00:00:00.000Z',
        });

        const refresher = oauth2Refresher({ tokenUrl: provider.tokenUrl, clientAuth: 'basic', client: { clientId: 'verify-client', clientSecret: 'verify-client-secret' } });
        const families = [one, two].map((runner) => createSecretsFamily({ backend: new SecretsSlotBackend(runner.address, {}) }));
        const seen = await Promise.all(families.map((family) => family.resolve(ref)));
        assert.equal(seen[0].version, seen[1].version);
        const [first, second] = await Promise.all(families.map((family, index) => family.refresh(ref, { seenVersion: seen[index].version, refresher })));

        assert.equal(provider.calls.filter((call) => call.grant === 'refresh_token').length, 1, 'refresh token calls');
        assert.equal(first.fields.access_token, 'access-2');
        assert.equal(second.fields.access_token, 'access-2');
        const held = await new SecretsSlotBackend({ baseUrl: doorUrl, token: key }, { team: seed.teamId }).resolve(ref);
        assert.equal(held?.fields.access_token, 'access-2');
        assert.equal(held?.fields.refresh_token, provider.currentRefreshToken());
      } finally {
        await one.close();
        await two.close();
        runners.splice(0, runners.length);
        await provider.close();
      }
    });
  } finally {
    for (const runner of runners) await runner.close();
    for (const ref of await entries()) {
      if (!before.has(ref)) await door.call('secrets.delete', { ref });
    }
    rmSync(project, { recursive: true, force: true });
  }

  console.log(`[lf-secrets-verify] ${results.pass} passed, ${results.fail} failed`);
  if (results.fail > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
    process.exit(1);
  });
