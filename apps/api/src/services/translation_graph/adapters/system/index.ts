// System's legacy line: the module's adapter and poll (@lf/system) built
// directly over the platform's records, as the registry built them before
// `system` was a module. Kept so the `BUILTIN_MODULES` line for `system` can
// go back to `legacy` in one edit while the module line is new; remove it with
// the line once the module line has soaked.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { PollSource } from '../../poll_source';

import { SYSTEM_POLL_INTERVAL_SECONDS, SystemAdapter, pollSystemEvents } from '@listen-fire/system';
import { platformSystemRecords } from './events';

export { SYSTEM_ADAPTER_TYPE, SYSTEM_MANIFEST } from '@listen-fire/system';

export function createSystemAdapter(_input: { teamId: TeamId }): SystemAdapter {
  return new SystemAdapter();
}

export function createSystemPollSource(input: { teamId: TeamId }): PollSource {
  return {
    pollIntervalSeconds: SYSTEM_POLL_INTERVAL_SECONDS,
    getEvents: (poll) => pollSystemEvents(platformSystemRecords, input.teamId, poll),
  };
}
