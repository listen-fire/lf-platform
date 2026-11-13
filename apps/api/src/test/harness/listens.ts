// A saved 0.13 listen as provisioning keeps it (inbound/listen_door.ts
// `listenConfigSchema`), written straight to its trigger row: for tests of
// what reads saved listens (shared polls, subscriptions, the doors) on a
// module the test fakes, where saving a program through the checker would
// need that module's catalog.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { MovementId } from '../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type { PlanHop } from 'engine-contracts';
import type { ListenConfig } from '../../services/inbound/listen_door';

import { getAutomationsQb } from '../../lib/kysely';

export interface TestListen {
  teamId: TeamId;
  movementId: MovementId;
  adapterType: string;
  edge: string;
  /** How the module delivers the edge. */
  delivery: NonNullable<ListenConfig['delivery']>['kind'];
  pollEverySeconds?: number;
  /** The part of the filter the module takes. */
  taken?: PlanHop['taken'];
  credentialsId?: string | null;
  movement?: string;
}

/** An equality on `field`, as a plan's taken filter carries it. */
export function takenEquals(field: string, value: string): NonNullable<PlanHop['taken']> {
  return { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: field }, right: { type: 'static', value } };
}

/** The listen as provisioning keeps it, named by `id`. */
export function testListenConfig(input: Omit<TestListen, 'teamId' | 'movementId' | 'credentialsId'>, id: string): ListenConfig {
  const movement = input.movement ?? 'heard';
  return {
    pipeline: `listen:test:${movement}:${id.slice(0, 8)}`,
    plan: {
      movement,
      connection: 'source',
      adapter: input.adapterType,
      hops: [{ edge: input.edge, from: '', to: 'Thing', judged: 'arrival', ...(input.taken !== undefined ? { taken: input.taken } : {}) }],
    },
    awaits: { own: [], carried: {} },
    fieldIds: {},
    delivery: { kind: input.delivery, ...(input.pollEverySeconds !== undefined ? { pollEverySeconds: input.pollEverySeconds } : {}) },
  };
}

/** Write one listen's trigger row; its id. */
export async function insertTestListen(input: TestListen): Promise<TriggerId> {
  const id = randomUUID() as TriggerId;
  const movement = input.movement ?? 'heard';
  const listen = testListenConfig(input, id);
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({
      id,
      team_id: input.teamId,
      name: `${movement}:${input.edge}`,
      kind: input.adapterType,
      config: JSON.stringify({ listen }),
      movement_id: input.movementId,
      credentials_id: (input.credentialsId ?? null) as ExternalServiceCredentialsId | null,
    })
    .execute();
  return id;
}
