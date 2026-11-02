// The system adapter's manifest: what the host's catalog, editor, handbook and
// checker read about it, construction-free.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { SYSTEM_HANDBOOK_SECTION } from './handbook_section';
import { DEFAULT_KIND, EVENTS_EDGE, KIND_FIELD, SYSTEM_ADAPTER_TYPE } from './types';

export const SYSTEM_MANIFEST: AdapterManifest = {
  adapterType: SYSTEM_ADAPTER_TYPE,
  displayName: 'Listen-Fire',
  description:
    'The platform itself, as a source. An automation listening to it runs when ' +
    'another automation fails — post the failure to Slack, open a ticket. Built ' +
    'in; nothing to connect.',
  authoringHints:
    'Every event arrives on `Events`; narrow it by `Kind` (`sys-[e:Events WHERE e.Kind == "Run Failed"]->`). ' +
    'Every event carries `Automation`, `Automation Id`, `Run Id`, `Version`, `Reason`, `Url` and `At`. ' +
    'An automation is never told about its own listen’s failures.',
  handbookSection: SYSTEM_HANDBOOK_SECTION,
  triggerExpectation:
    'Fires on the platform’s own events, polled every minute by default: a run of ANOTHER automation ' +
    'in this workspace ending failed or pausing at its cost limit (never a rehearsal), a wait whose ' +
    'record was deleted, a listen that could not judge an arrival, a release deployed. The first poll ' +
    'sets the mark and emits nothing, so going live never replays past events.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue'],
  // A 0.12 `listen to sys { events: ["Run Failed", "Run Paused"] }` is
  // `listen to sys-[e:Events WHERE e.Kind IN ["Run Failed", "Run Paused"]]->`;
  // one naming no events heard `Run Failed`.
  listenSettingsBecome: {
    path: [EVENTS_EDGE],
    aliases: ['e'],
    paramFrom: DEFAULT_KIND.name,
    keys: { events: { hop: 0, field: KIND_FIELD, op: 'in', absent: DEFAULT_KIND.name } },
  },
  vocabulary: {
    // A built-in owns no brand, but it still owns a mark (see the manual
    // adapter). A pulse line: the platform's own heartbeat.
    icon: {
      d: 'M3 12 H8 L10 7 L14 17 L16 12 H21',
      fill: false,
    },
    eventPhrase: {
      default: [{ template: 'When something happens to another automation' }],
    },
  },
};
