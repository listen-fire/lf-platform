// The wake slot's filling, from the environment: WAKE_MODULE names the module
// and each WAKE_SETTING__<NAME> is its setting <name>. The module is imported
// in-process, as the limiter is, so a drain job started per wake costs no
// second process. Unset, the slot stays empty and nothing is told.

import { logger } from 'movement-engine/public/log';
import { CloudTasksWake, WakeSettingError, readInstall } from '@listen-fire/wake-cloud-tasks/cloud_tasks';

import { installWake } from '../services/work/wake';

type Env = Record<string, string | undefined>;

const WAKE_MODULE_VAR = 'WAKE_MODULE';
const WAKE_SETTING_PREFIX = 'WAKE_SETTING__';
const CLOUD_TASKS_MODULE = '@listen-fire/wake-cloud-tasks';

function wakeSettings(env: Env): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(WAKE_SETTING_PREFIX) || value === undefined) continue;
    settings[name.slice(WAKE_SETTING_PREFIX.length).toLowerCase()] = value;
  }
  return settings;
}

/** The wake WAKE_MODULE names, built from its settings; undefined when it is
 *  unset. A module this build does not know, or a setting it refuses, throws
 *  naming the variable (never a setting's value). */
function wakeFromEnv(env: Env): CloudTasksWake | undefined {
  const module = env[WAKE_MODULE_VAR]?.trim() ?? '';
  if (module === '') return undefined;
  if (module !== CLOUD_TASKS_MODULE) {
    throw new Error(`${WAKE_MODULE_VAR} names "${module}", which this build does not know: the one it knows is ${CLOUD_TASKS_MODULE}.`);
  }
  try {
    return new CloudTasksWake(readInstall(wakeSettings(env)));
  } catch (error) {
    if (error instanceof WakeSettingError) {
      throw new Error(`${WAKE_SETTING_PREFIX}${error.setting.toUpperCase()}: ${error.message}`);
    }
    throw error;
  }
}

/** Fill the wake slot from the environment, before the process enqueues. */
function installWakeFromEnv(env: Env = process.env): void {
  const wake = wakeFromEnv(env);
  installWake(wake);
  if (wake === undefined) return;
  logger.info(
    `[wake] each row's due time is told to ${CLOUD_TASKS_MODULE}: tasks on queue ${wake.install.queue} start job ${wake.install.job}`,
    { queue: wake.install.queue, job: wake.install.job },
  );
}

export { WAKE_MODULE_VAR, WAKE_SETTING_PREFIX, installWakeFromEnv, wakeFromEnv };
