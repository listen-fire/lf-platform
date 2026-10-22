/**
 * The deploy check: once per release, after migrations and before the api
 * takes traffic, re-validate every saved automation and report which ones
 * validate cleanly under the release's current version. It never moves a
 * language version pin: only an explicit upgrade does
 * (services/translation_graph/movement/language_upgrade.ts).
 *
 * It runs in the `migrate` one-shot (deploy/docker-compose.yml; Render's
 * preDeployCommand), which runs exactly once per deployment however many api
 * replicas follow it, and which the api waits on. A second run on the same
 * release does nothing.
 *
 * It never fails the deployment: a check that cannot finish logs why and exits
 * 0, because it changes no pin — while a failed one-shot would keep the api from starting.
 *
 * Usage:
 *   node build/scripts/deploy_check.js             # run the check
 *   node build/scripts/deploy_check.js --summary   # print the last check's summary
 *   pnpm deploy:check [--summary]                  # the same, against the dev loop
 */

import '../services';
import { LISTEN_FIRE_VERSION } from '../constants';
import { mounts } from '../products';
import { logger } from 'movement-engine/public/log';
import {
  DEPLOY_CHECK_OUTCOMES,
  latestDeployCheckSummary,
  liveDeployCheckDeps,
  runDeployCheck,
  thisDeployCheckRelease,
  type DeployCheckOutcome,
  type DeployCheckSummary,
} from '../services/translation_graph/movement/language_upgrade';
import { neverAsAny } from 'movement-engine/public/types';

function outcomeHeading(outcome: DeployCheckOutcome): string {
  switch (outcome) {
    case 'upgradable':
      return 'Legacy versions clean under the installed language — offered the upgrade, pin unchanged';
    case 'current':
      return 'On the installed language';
    case 'warned':
      return 'Kept on a legacy version — not clean under the installed language';
    case 'refused':
      return 'NOT VALIDATING under their own version, or pinned to a language this release does not read (a legacy version failing, unless marked already failing, is a bug — report it)';
    case 'unverified':
      return 'Could not be checked — kept where they were';
    default:
      return neverAsAny(outcome);
  }
}

/** The table `deploy/up.sh` prints: upgradable / warned / refused, by name. */
export function renderSummary(summary: DeployCheckSummary): string {
  const lines = [
    `Deploy check for release ${summary.release} (${summary.ranAt}), ` +
      `installed language ${summary.current.version}:`,
  ];
  for (const outcome of DEPLOY_CHECK_OUTCOMES) {
    const entries = summary.automations.filter((a) => a.outcome === outcome);
    if (entries.length === 0) continue;
    lines.push(`  ${outcomeHeading(outcome)}: ${entries.length}`);
    // The already-current majority is a count, not a list.
    if (outcome === 'current') continue;
    for (const entry of entries) {
      const move =
        entry.from.version === entry.to.version
          ? `${entry.from.version}`
          : `${entry.from.version} -> ${entry.to.version}`;
      const detail = entry.detail === '' ? '' : ` — ${entry.detail}`;
      lines.push(`    - ${entry.name} (${move}${entry.deprecated ? ', deprecated' : ''})${detail}`);
      if (entry.notes !== undefined) lines.push(`      note (does not block): ${entry.notes}`);
    }
  }
  if (summary.automations.length === 0) lines.push('  No saved automations.');
  return lines.join('\n');
}

async function printSummary(): Promise<void> {
  const summary = await latestDeployCheckSummary();
  console.log(summary === null ? 'No deploy check has run on this database yet.' : renderSummary(summary));
}

async function runCheck(): Promise<void> {
  if (!mounts('automations')) {
    logger.info('[DeployCheck] this deployment runs no automations — nothing to check');
    return;
  }
  const summary = await runDeployCheck(liveDeployCheckDeps(thisDeployCheckRelease(LISTEN_FIRE_VERSION)));
  if (summary === null) {
    logger.info(`[DeployCheck] release ${LISTEN_FIRE_VERSION} was already checked — nothing to do`);
    return;
  }
  console.log(renderSummary(summary));
}

export async function deployCheckMain(): Promise<void> {
  if (process.argv.includes('--summary')) {
    await printSummary();
    return;
  }
  try {
    await runCheck();
  } catch (err) {
    logger.error('[DeployCheck] the check could not finish — it moves no pin, so nothing changed', {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }
}

if (require.main === module) {
  deployCheckMain()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[DeployCheck] failed', err);
      process.exit(process.argv.includes('--summary') ? 1 : 0);
    });
}
