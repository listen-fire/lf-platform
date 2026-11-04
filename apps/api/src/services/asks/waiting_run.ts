// Whether the run parked on an ask is on a legacy language version, which this
// release cannot resume: its answer can go nowhere.

import { ASK_ADAPTER_TYPE } from '@listen-fire/ask';
import { isLegacyLanguageVersion } from 'legacy-lang';

import type { AskId } from '../../generated/kysely/asks/Ask';

import { getAutomationsQb } from '../../lib/kysely';

export async function waitingRunIsLegacy(askId: AskId): Promise<boolean> {
  const row = await getAutomationsQb(['adapter_await', 'trigger_run', 'movement_version'])
    .selectFrom('adapter_await')
    .innerJoin('trigger_run', 'trigger_run.id', 'adapter_await.run_id')
    .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
    .where('adapter_await.adapter_type', '=', ASK_ADAPTER_TYPE)
    .where('adapter_await.correlation_key', '=', askId as unknown as string)
    .select('movement_version.language_version')
    .executeTakeFirst();
  return row !== undefined && isLegacyLanguageVersion(row.language_version);
}
