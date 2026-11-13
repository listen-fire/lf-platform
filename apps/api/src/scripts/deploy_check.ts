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
 * It fails the deployment in one case only: a run parked on a version this
 * release does not run (a legacy id, or 0.12, whose engine it dropped), which
 * nothing here can continue. It is named, and the deployment stops until it is
 * answered or cancelled on the release that parked it. Otherwise a check that
 * cannot finish logs why and exits 0, because it changes no pin, while a failed
 * one-shot would keep the api from starting.
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
import { droppedPins, type DroppedPins } from '../services/translation_graph/movement/dropped_pins';
import { neverAsAny } from 'movement-engine/public/types';

function outcomeHeading(outcome: DeployCheckOutcome): string {
  switch (outcome) {
    case 'upgradable':
      return 'Legacy versions clean under the installed language — offered the upgrade, pin unchanged';
    case 'current':
      return 'On the installed language';
    case 'carried':
      return 'On a version this release carries — they keep firing on it, pin unchanged';
    case 'warned':
      return 'Kept on a legacy version — not clean under the installed language';
    case 'stopped':
      return 'Written for an earlier release — refused by name: they do not fire until upgraded';
    case 'refused':
      return 'NOT VALIDATING under their own version, or pinned to a newer language than this release reads (a legacy version failing, unless marked already failing, is a bug — report it)';
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
  const legacy = summary.legacyStopped ?? [];
  if (legacy.length > 0) lines.push(`  On language versions 1 to 4 or 0.12, which this release does not run — no new run starts on them until they are upgraded: ${legacy.length}`);
  for (const entry of legacy) {
    lines.push(`    - ${entry.name} (${entry.pin}): ${entry.remedy}`);
    if (entry.waitingRuns.length > 0) {
      lines.push(`      paused on a question, a callback or a reply, which cannot continue here: ${entry.waitingRuns.join(', ')}. Cancel them, then upgrade the automation`);
    }
  }
  if (summary.automations.length === 0) lines.push('  No saved automations.');
  return lines.join('\n');
}

/** The automations on a version this release does not run, and the runs
 *  parked on one. Empty when there are none. */
export function renderDropped(dropped: DroppedPins): string {
  const lines: string[] = [];
  if (dropped.automations.length > 0) {
    lines.push(`On language versions this release does not run (1 to 4, or 0.12): ${dropped.automations.length} automations, which start nothing until they are upgraded`);
    for (const automation of dropped.automations) lines.push(`  - ${automation.name} (${automation.pin}), team ${automation.teamId}`);
  }
  if (dropped.parkedRuns.length > 0) {
    lines.push(
      `REFUSED: ${dropped.parkedRuns.length} runs are parked on them, which this release cannot continue. ` +
        'Answer or cancel each on the release that parked it, then deploy again:',
    );
    for (const run of dropped.parkedRuns) lines.push(`  - run ${run.id} of ${run.automation} (${run.pin}), team ${run.teamId}`);
  }
  return lines.join('\n');
}

/** Whether this release may take traffic: not while a run is parked on a
 *  version it does not run. Every automation on one is named either way. */
export async function droppedPinsAllowDeploy(): Promise<boolean> {
  const dropped = await droppedPins();
  const text = renderDropped(dropped);
  if (text !== '') console.log(text);
  if (dropped.parkedRuns.length === 0) return true;
  logger.error('[DeployCheck] runs are parked on a language version this release does not run: the deployment stops', {
    runs: dropped.parkedRuns.map((run) => run.id),
  });
  return false;
}

async function printSummary(): Promise<void> {
  const summary = await latestDeployCheckSummary();
  console.log(summary === null ? 'No deploy check has run on this database yet.' : renderSummary(summary));
}

async function runCheck(): Promise<void> {
  const summary = await runDeployCheck(liveDeployCheckDeps(thisDeployCheckRelease(LISTEN_FIRE_VERSION)));
  if (summary === null) {
    logger.info(`[DeployCheck] release ${LISTEN_FIRE_VERSION} was already checked — nothing to do`);
    return;
  }
  console.log(renderSummary(summary));
}

/** The exit code the one-shot ends with: 1 only while a run is parked on a
 *  version this release does not run. */
export async function deployCheckMain(): Promise<number> {
  if (process.argv.includes('--summary')) {
    await printSummary();
    return 0;
  }
  if (!mounts('automations')) {
    logger.info('[DeployCheck] this deployment runs no automations — nothing to check');
    return 0;
  }
  // Outside the try: a deployment that cannot tell whether a run would be
  // stranded does not go ahead.
  if (!(await droppedPinsAllowDeploy())) return 1;
  try {
    await runCheck();
  } catch (err) {
    logger.error('[DeployCheck] the check could not finish — it moves no pin, so nothing changed', {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }
  return 0;
}

if (require.main === module) {
  deployCheckMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Only the summary and the parked runs' count reach here: the check
      // itself is caught inside, and neither may be taken for a pass.
      logger.error('[DeployCheck] failed', err);
      process.exit(1);
    });
}
