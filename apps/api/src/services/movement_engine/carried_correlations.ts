// The correlation map a run parked under a carried version keeps its awaits in
// (`automations.adapter_await`), restored from production at 0.12.13: an await
// parked on an adapter identity, woken by a `wake_await` row naming that
// identity. The current version's waits never touch it.

import { randomUUID } from 'node:crypto';

import type { CarriedRunStore, CorrelatedPark } from '@listen-fire/language-versions';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../lib/kysely';
import { enqueueWork } from '../work/store';

/** A wake per correlation key one signal named: a key nothing is parked on
 *  drains as a no-op. A signal's wake is never coalesced, so a second signal on
 *  one identity still drives what the first pass looked past. */
export async function queueAwaitWakesOf(input: { adapterType: string; teamId: string; keys: readonly string[] }): Promise<void> {
  for (const correlationKey of input.keys) {
    await enqueueWork({
      kind: 'wake_await',
      key: `wake_await:${randomUUID()}`,
      teamId: input.teamId,
      payload: { adapterType: input.adapterType, teamId: input.teamId, correlationKey },
    });
  }
}

const runIdOf = (runId: string) => runId as TriggerRunId;

export async function dropRunCorrelations(runId: TriggerRunId): Promise<void> {
  await getAutomationsQb(['adapter_await']).deleteFrom('adapter_await').where('run_id', '=', runId).execute();
}

export const postgresCorrelations: CarriedRunStore['correlations'] = {
  async correlate({ runId, teamId, address, adapterType, correlationKey }) {
    await getAutomationsQb(['adapter_await'])
      .insertInto('adapter_await')
      .values({ adapter_type: adapterType, correlation_key: correlationKey, run_id: runIdOf(runId), team_id: teamId, address })
      .onConflict((oc) =>
        oc.columns(['run_id', 'address']).doUpdateSet({
          adapter_type: adapterType,
          correlation_key: correlationKey,
          updated_at: new Date(),
        }),
      )
      .execute();
  },

  // The platform's runs only: an lf run's awaits are woken by lf.
  async correlated({ adapterType, teamId, correlationKey }) {
    const rows = await getAutomationsQb(['adapter_await', 'trigger_run'])
      .selectFrom('adapter_await')
      .innerJoin('trigger_run', 'trigger_run.id', 'adapter_await.run_id')
      .where('trigger_run.host', '=', 'platform')
      .where('adapter_await.adapter_type', '=', adapterType)
      .where('adapter_await.team_id', '=', teamId)
      .where('adapter_await.correlation_key', '=', correlationKey)
      .select(['adapter_await.run_id', 'adapter_await.team_id', 'adapter_await.address'])
      .orderBy('adapter_await.created_at')
      .execute();
    return rows.map((r): CorrelatedPark => ({ runId: r.run_id, teamId: r.team_id, address: r.address }));
  },

  async ofRun({ runId, adapterType }) {
    const rows = await getAutomationsQb(['adapter_await'])
      .selectFrom('adapter_await')
      .where('run_id', '=', runIdOf(runId))
      .where('adapter_type', '=', adapterType)
      .select(['run_id', 'team_id', 'address', 'correlation_key'])
      .orderBy('address')
      .execute();
    return rows.map((r) => ({ runId: r.run_id, teamId: r.team_id, address: r.address, correlationKey: r.correlation_key }));
  },

  async drop({ runId, address }) {
    await getAutomationsQb(['adapter_await']).deleteFrom('adapter_await').where('run_id', '=', runIdOf(runId)).where('address', '=', address).execute();
  },

  async dropRun({ runId }) {
    await dropRunCorrelations(runIdOf(runId));
  },
};
