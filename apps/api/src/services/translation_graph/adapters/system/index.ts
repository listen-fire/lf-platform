// System's adapter, for the registry's factory table. The module line
// (`BUILTIN_MODULES.system`) serves its poll, over the platform's records.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { SystemAdapter } from '@listen-fire/system';

export { SYSTEM_ADAPTER_TYPE, SYSTEM_MANIFEST } from '@listen-fire/system';

export function createSystemAdapter(_input: { teamId: TeamId }): SystemAdapter {
  return new SystemAdapter();
}
