// `@lf/system`: the platform itself as a source, as a module. Platform-
// supplied: only the platform keeps the records it reads (its runs, the
// events it stores), so the platform defines it with them
// (`systemModuleWith`) and hosts it in process. There is no lf story and no
// process transport: nothing outside the platform has these records.

import { defineModule, type AdapterModuleDefinition } from 'module-kit';

import { SystemAdapter } from './adapter';
import { SYSTEM_MANIFEST } from './manifest';
import { SYSTEM_POLL_INTERVAL_SECONDS, pollSystemEvents, type SystemRecords } from './poll';

/** `@lf/system` over the host's records of its own events. */
export function systemModuleWith(records: SystemRecords): AdapterModuleDefinition {
  return defineModule({
    kind: 'adapter',
    name: '@lf/system',
    manifest: SYSTEM_MANIFEST,
    credentials: [],
    poll: { intervalSeconds: SYSTEM_POLL_INTERVAL_SECONDS },
    create: (ctx) => {
      const adapter = new SystemAdapter();
      return Object.assign(adapter, {
        poll: (input: Parameters<typeof pollSystemEvents>[2]) => pollSystemEvents(records, ctx.config.tenant, input),
      });
    },
  });
}

export * from './adapter';
export * from './handbook_section';
export * from './manifest';
export * from './poll';
export * from './types';
