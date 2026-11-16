// What the host lists `@lf/native-valuations` by, without loading it.

import type { AdapterManifest } from '@listen-fire/engine/public/adapter';

import { META_RECORD_TYPE } from '@listen-fire/engine/public/catalog';

import { VALUATIONS_CHANGES_EDGE } from './changes';
import { NATIVE_VALUATIONS_ADAPTER_TYPE } from './types';

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
    'listEntryPoints', 'describe', 'getFieldValue', 'preprocessInbound', 'awaitKeys',
    'getRelated', 'createRecord', 'updateRecord', 'deleteRecord',
    'readRecord', 'translateFilter', 'ensureEventSubscription', 'removeEventSubscription',
  ],
  requiredCredentialType: 'NATIVE_VALUATIONS',
  metaRecordType: META_RECORD_TYPE,
  triggerKinds: ['NATIVE_VALUATIONS'],
  // A 0.12 listen (`{ events: ["valuations:legal_entity:update", …] }`, the
  // only entity it could name) is a listen on a legal entity's `Changes`,
  // its events compared as `Kind`.
  listenSettingsBecome: {
    path: ['Legal Entity', VALUATIONS_CHANGES_EDGE],
    aliases: ['e', 'c'],
    keys: {
      events: {
        hop: 1,
        field: 'Kind',
        op: 'in',
        values: {
          'valuations:legal_entity:create': 'created',
          'valuations:legal_entity:update': 'updated',
          'valuations:legal_entity:delete': 'deleted',
        },
      },
    },
  },
  triggerExpectation:
    "Listen on a record's Changes: vals-[e:`Legal Entity`]->-[c:Changes WHERE c.Kind == \"updated\"]->. " +
    'It fires when a row changes inside Listen-Fire Valuations (its own webhook, managed automatically): ' +
    'created, updated or deleted, with the row as it was (`Previous`) and as the change left it (`Current`). ' +
    'Changes made outside Valuations (e.g. in a spreadsheet that feeds it) are not seen until they land in Valuations.',
  vocabulary: {
    // No brand mark — Listen-Fire's own product, not a third-party system.
    eventPhrase: {
      // No per-event phrasing today (the former switch used one generic
      // sentence for every NATIVE_VALUATIONS event) — `default` mirrors that.
      default: [{ template: 'When a valuation report is produced' }],
    },
  },
};
