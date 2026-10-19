// What the host lists `@lf/native-valuations` by, without loading it.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { META_RECORD_TYPE } from 'movement-engine/public/catalog';

import { NATIVE_VALUATIONS_ADAPTER_TYPE, NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS } from './types';

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. `metaRecordType` signals the Manual (meta-rooted) sync;
 * a real `createRecord` makes it a write target.
 *
 */
export const NATIVE_VALUATIONS_MANIFEST: AdapterManifest = {
  adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
  displayName: 'Listen-Fire Valuations',
  description:
    "Listen-Fire's valuations product. Read and write valuation records and react " +
    'when they change.',
  supportedTriggers: ['webhook', 'snapshot', 'mutation'],
  methods: [
    'listEntryPoints', 'describe', 'listEventTypes', 'getFieldValue', 'preprocessInbound',
    'getRelated', 'createRecord', 'updateRecord', 'deleteRecord',
    'readRecord', 'translateFilter', 'ensureEventSubscription', 'removeEventSubscription',
  ],
  requiredCredentialType: 'NATIVE_VALUATIONS',
  metaRecordType: META_RECORD_TYPE,
  triggerKinds: ['NATIVE_VALUATIONS'],
  // The Valuations events a `listen to <vals> { events: [...] }` subscribes to —
  // the `events` listen-config vocabulary, folded into the webhook registration.
  // `events` is REQUIRED: a Valuations listen must name what it watches.
  subscribableEvents: [...NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS],
  listenConfig: [{ key: 'events', required: true }],
  triggerExpectation:
    'Fires when data changes inside Listen-Fire Valuations (its own webhook, ' +
    'managed automatically) — the listen MUST name the events it watches, ' +
    'and only those arrive. Changes made outside Valuations (e.g. in a ' +
    'spreadsheet that feeds it) are not seen until they land in Valuations.',
  vocabulary: {
    // No brand mark — Listen-Fire's own product, not a third-party system.
    eventPhrase: {
      // No per-event phrasing today (the former switch used one generic
      // sentence for every NATIVE_VALUATIONS event) — `default` mirrors that.
      default: [{ template: 'When a valuation report is produced' }],
    },
  },
};
