// The system adapter's manifest: what the host's catalog, editor, handbook and
// checker read about it, construction-free.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { SYSTEM_HANDBOOK_SECTION } from './handbook_section';
import { RUN_FAILED, SYSTEM_ADAPTER_TYPE, SYSTEM_SUBSCRIBABLE_EVENTS } from './types';

export const SYSTEM_MANIFEST: AdapterManifest = {
  adapterType: SYSTEM_ADAPTER_TYPE,
  displayName: 'Listen-Fire',
  description:
    'The platform itself, as a source. An automation listening to it runs when ' +
    'another automation fails — post the failure to Slack, open a ticket. Built ' +
    'in; nothing to connect.',
  authoringHints:
    'Every event carries `Automation`, `Automation Id`, `Run Id`, `Version`, ' +
    '`Reason`, `Url` and `At`. `Run Failed` is delivered as runs fail; ' +
    '`Validation Issue`, `Deprecated Version` and `Release Applied` as a new ' +
    'release is deployed. An automation is never told about its own failures.',
  handbookSection: SYSTEM_HANDBOOK_SECTION,
  triggerExpectation:
    'Fires on the platform’s own events, selected with `events`. `Run Failed` ' +
    '(the default) fires once per run of ANOTHER automation in this workspace ' +
    'that ends failed, within a couple of minutes — never for the listening ' +
    'automation’s own runs, and never for a rehearsal. `Validation Issue` and ' +
    '`Deprecated Version` fire once per affected automation, and `Release Applied` ' +
    'once per workspace, each time a new release is deployed. The first poll sets ' +
    'the mark and emits nothing, so going live never replays past events.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue', 'listEventTypes'],
  subscribableEvents: [...SYSTEM_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [RUN_FAILED.displayName],
  listenConfig: [{ key: 'pollIntervalSeconds', required: false }],
  vocabulary: {
    // A built-in owns no brand, but it still owns a mark (see the manual
    // adapter). A pulse line: the platform's own heartbeat.
    icon: {
      d: 'M3 12 H8 L10 7 L14 17 L16 12 H21',
      fill: false,
    },
    eventPhrase: {
      default: [{ template: 'When another automation’s run fails' }],
    },
  },
};
