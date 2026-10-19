// `@lf/kg`: the knowledge graph as a module. The host supplies the store the
// graph lives in (`KgStore`), scoped to the install's team and connection; the
// module translates a program's natural names to the store's ids and back,
// declares the graph's record types (read live from the team's model) and its
// change event, and turns the store's change envelopes into events through
// `preprocessInbound`, so the host carries them through its inbound path and
// work queue like any adapter's. Nothing here reaches a database or runs a
// movement.

import { defineModule, type AdapterModuleDefinition, type ModuleContext } from 'module-kit';

import type { KgStore } from './store';

import { KnowledgeGraphAdapter } from './adapter';
import { KG_CREDENTIAL_TYPE, KG_INBOUND, kgManifest } from './manifest';

export interface KgModuleHost {
  /** The store for one install: its team is `ctx.config.tenant`, its
   *  connection `ctx.config.credentialRef`. */
  store(ctx: ModuleContext): KgStore;
  /** Whether the store's change events reach this host as signed webhooks (a
   *  store in another process), so the listen reconciler registers them. */
  changeWebhooks: boolean;
}

/** `@lf/kg` over the host's store. */
export function kgModuleWith(host: KgModuleHost): AdapterModuleDefinition {
  return defineModule({
    kind: 'adapter',
    name: '@lf/kg',
    manifest: kgManifest({ changeWebhooks: host.changeWebhooks }),
    credentials: [
      {
        name: 'knowledge',
        kind: 'static',
        fields: [
          { name: 'apiKey', label: 'API key' },
          { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
        ],
      },
    ],
    inbound: KG_INBOUND,
    create: (ctx) => new KnowledgeGraphAdapter({ store: host.store(ctx), log: ctx.log }),
  });
}

export { KG_CREDENTIAL_TYPE };
export * from './adapter';
export * from './events';
export * from './handbook_section';
export * from './manifest';
export * from './store';
export * from './writes';
