// `@lf/system`: the platform itself as a source, as a module. Platform-
// supplied: only the platform keeps the facts it reads (its runs, waits and
// releases), so the platform defines it with them (`systemModuleWith`),
// hosts it in process, and serves it to a cloud lf at a route of its own over
// the adapter protocol. It is never published: no other host has these
// facts. Its shape is listen-fire's bundled `@lf/system`
// (docs/contracts/system-events.md in listen-fire).

import { defineModule, type AdapterModuleDefinition, type ModuleContext, type PollEdgeInput } from '@listen-fire/module-kit';

import { SystemAdapter } from './adapter';
import { SYSTEM_MANIFEST } from './manifest';
import { DEFAULT_POLL_SETTINGS, SYSTEM_POLL_EVERY_SECONDS, pollSystemEvents, type SystemPollSettings } from './poll';
import type { SystemRecords } from './records';

/** `@lf/system` over the facts `recordsOf` reads for a call's context (its
 *  tenant is `ctx.config.tenant`). */
export function systemModuleWith(recordsOf: (ctx: ModuleContext) => SystemRecords, settings: SystemPollSettings = DEFAULT_POLL_SETTINGS): AdapterModuleDefinition {
  return defineModule({
    kind: 'adapter',
    name: '@lf/system',
    manifest: SYSTEM_MANIFEST,
    // Adapter protocol 2.6: a poll of a listenable edge, and an arrival's
    // `about`, `notFor` and `occurredAt`.
    protocolMinor: 6,
    credentials: [],
    poll: { intervalSeconds: SYSTEM_POLL_EVERY_SECONDS },
    create: (ctx) =>
      Object.assign(new SystemAdapter(), {
        poll: async (input: PollEdgeInput) => pollSystemEvents(recordsOf(ctx), input, settings),
      }),
  });
}

export * from './adapter';
export * from './handbook_section';
export * from './manifest';
export * from './poll';
export * from './records';
export * from './types';
