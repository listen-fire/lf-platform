// The cron unit as production described it at 0.12: its manifest, and the
// describing half of its adapter (`listEntryPoints`, `describe`). Ticks are
// produced by the scheduler, the running half, which this package does not
// carry.
//
//   listen to cron { schedule: "0 9 * * 1" } fire digest

import type { Adapter, AdapterManifest } from '@listen-fire/engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor } from '@listen-fire/engine/public/catalog';

import { BaseAdapter } from '@listen-fire/module-kit/adapter/base';

import { CRON_HANDBOOK_SECTION } from './handbook_section';

/** Stable adapter identifier — the trigger `kind` of cron-derived rows. */
export const CRON_ADAPTER_TYPE = 'cron';

/** Type id for the tick position a schedule firing seeds. Internal currency —
 *  stays lowercase; the natural name authors see is `CRON_TICK_DISPLAY_NAME`. */
export const CRON_TICK_TYPE_ID = 'tick';

/** Natural type name for a tick — TitleCase, like every other graph's nodes
 *  (adapters/CLAUDE.md). The event seed keys its position by this name (the
 *  address is the natural node name, layer 8), so field reads resolve it
 *  through the resolver; the typeId stays stable. */
export const CRON_TICK_DISPLAY_NAME = 'Tick';

/** The one subscribable event — what the platform scheduler emits. */
export const CRON_TICK_EVENT = 'tick';

/**
 * Static manifest. Source-only, credential-free. `listenConfig` declares
 * the `schedule` routing key (required, cron-format-validated at check
 * time); `subscribableEvents` + `ensureEventSubscription` put the channel
 * on the same listen-reconciliation seam as external webhooks.
 */
export const CRON_MANIFEST: AdapterManifest = {
  adapterType: CRON_ADAPTER_TYPE,
  displayName: 'Schedule',
  description:
    'Time as a source. A schedule emits an event when it comes due, and a ' +
    'movement listening to it runs — weekly digests, nightly mirrors. Built ' +
    'in; nothing to connect.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue',
    'ensureEventSubscription', 'removeEventSubscription',
  ],
  subscribableEvents: [CRON_TICK_EVENT],
  listenConfig: [
    { key: 'schedule', required: true, format: 'cron' },
    // Optional IANA timezone the schedule is interpreted in (wall-clock).
    // Absent ⇒ UTC. Handles DST automatically (e.g. Europe/London → 09:00
    // local across BST/GMT).
    { key: 'timezone', required: false, format: 'timezone' },
  ],
  // Self-alias: the subscription row's provider key stays the lowercase
  // slug (there is no legacy uppercase channel for an intrinsic adapter).
  triggerKinds: [CRON_ADAPTER_TYPE],
  triggerExpectation:
    'Fires on the schedule configured on the listener (a cron expression) — ' +
    'nothing external triggers it, and the event carries only the tick time. ' +
    'Present it as periodic work, never as reacting to data changes.',
  handbookSection: CRON_HANDBOOK_SECTION,
  vocabulary: {
    // A built-in owns no brand, but it still owns a MARK — see the manual
    // adapter for why. A clock is the whole of what this source is.
    icon: {
      d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18 M12 7.5 V12 l3.2 1.9',
      fill: false,
    },
  },
};

export class CronSurface extends BaseAdapter implements Adapter {
  readonly adapterType = CRON_ADAPTER_TYPE;
  readonly supportedTriggers = CRON_MANIFEST.supportedTriggers;

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // The natural name (`Tick`, TitleCase) is the currency authors, the
    // checker, and the hover all use; the internal `tick` typeId lives only in
    // this adapter's private cache. They no longer need to be identical: the
    // event edge keys its seed position by the natural node NAME (the address,
    // layer 8), and describe accepts either spelling — so field reads resolve
    // through the resolver whichever way the seed is stamped.
    return [
      {
        typeId: CRON_TICK_TYPE_ID,
        displayName: CRON_TICK_DISPLAY_NAME,
        writable: false,
        // Nothing enumerates ticks — they are DELIVERED. `readable: true` was
        // the encoding's forced lie (it minted a `timer-[t:tick]->` root
        // collection nothing could serve); the event edge marker is what the
        // honest spelling was blocked on. No change-kind axis, so no `action`
        // field: a tick is just a node a listen delivers.
        readable: false,
        fires: true,
      },
    ];
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId !== CRON_TICK_TYPE_ID) return null;
    return {
      typeId: CRON_TICK_TYPE_ID,
      displayName: CRON_TICK_DISPLAY_NAME,
      description: 'One scheduled firing — when it was due, and on which schedule.',
      fields: [
        { fieldId: 'firedAt', displayName: 'Fired at', kind: 'date', writable: false, required: true, description: 'The scheduled occurrence this tick fired for (UTC).' },
        { fieldId: 'schedule', displayName: 'Schedule', kind: 'string', writable: false, required: true, description: 'The cron schedule that produced this tick.' },
      ],
      references: [],
    };
  }
}
