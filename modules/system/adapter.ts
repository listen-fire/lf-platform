// The system adapter's read surface: the host itself as a source a program
// listens to. Read-only and credential-free: nothing is written or listed
// here. Its events are delivered on one root edge, `Events`, polled
// (poll.ts), each landing on an `Event` whose `Kind` a listen narrows.

import type { Adapter, EdgesFromResult } from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';

import { uniformWalk } from 'module-kit/adapter/hop';
import { BaseAdapter } from 'module-kit/adapter/base';
import { META_RECORD_TYPE, positionData } from 'movement-engine/public/catalog';
import { SYSTEM_MANIFEST } from './manifest';
import { SYSTEM_POLL_EVERY_SECONDS } from './poll';
import { EVENT_TYPE, EVENTS_EDGE, KIND_FIELD, SYSTEM_ADAPTER_TYPE, SYSTEM_EVENT_FIELDS, SYSTEM_EVENT_KINDS } from './types';

/** The one record shape every kind lands on. */
const EVENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVENT_TYPE,
  displayName: EVENT_TYPE,
  description: 'Something that happened to the host’s runs, waits or releases. `Kind` says which.',
  fields: SYSTEM_EVENT_FIELDS.map((field) => ({
    fieldId: field.name,
    displayName: field.name,
    kind: field.kind,
    writable: false,
    required: true,
    description: field.description,
    ...(field.name === KIND_FIELD ? { enumValues: SYSTEM_EVENT_KINDS.map((kind) => kind.name), capability: { filterOperators: ['eq', 'in'] } } : {}),
  })),
  references: [],
};

/** The root's one edge: listened to, never read or written. */
const EVENTS_ENTRY: SchemaEntryPoint = {
  typeId: EVENT_TYPE,
  displayName: EVENT_TYPE,
  collectionName: EVENTS_EDGE,
  readable: false,
  writable: false,
  listenable: true,
  delivery: 'polled',
  pollEverySeconds: SYSTEM_POLL_EVERY_SECONDS,
  cursor: true,
  identity: 'Event Id',
  // Each event about a run says so (`about` the host's `Run`): the host's
  // loop breaker continues that run's chain.
  attributes: true,
  capability: { filter: 'native', supportsLimit: false },
};

/** The host itself: nothing listed, one edge listened to. */
const ROOT: SchemaTypeDescriptor = {
  typeId: META_RECORD_TYPE,
  displayName: 'Listen-Fire',
  description: 'The host itself. Nothing here can be listed: its events are delivered on `Events`, which a listen narrows by `Kind`.',
  fields: [],
  references: [
    {
      fieldId: EVENT_TYPE,
      targetTypeId: EVENT_TYPE,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVENTS_EDGE,
      listenable: true,
      readable: false,
      writable: false,
      description: 'Each thing that happens to the host’s runs, waits or releases, as it is found.',
    },
  ],
};

export class SystemAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = SYSTEM_ADAPTER_TYPE;
  readonly supportedTriggers = SYSTEM_MANIFEST.supportedTriggers;

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [EVENTS_ENTRY];
  }

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({ adapterType: SYSTEM_ADAPTER_TYPE, at: position, root: ROOT, describe: (typeId) => this.describe(typeId) });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    return typeId === EVENT_TYPE ? EVENT_DESCRIPTOR : null;
  }

  async getFieldValue(input: { position: SourcePosition; fieldId: string }): Promise<unknown> {
    if (input.position.adapterType !== SYSTEM_ADAPTER_TYPE) {
      throw new Error(`SystemAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`);
    }
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    return data[fieldId] ?? null;
  }
}
