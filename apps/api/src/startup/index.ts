// The composition root for background work: which units' registries this
// process runs.
//
// Everything below is "this unit's registry, if this unit is mounted". There
// is no worker here. (The knowledge graph's change events reach the engine
// through the automations drain, which registers their work kind itself.)

import { mounts, mountedProducts } from '../products';
import { asksWorkers } from './asks';
import { automationsWorkers } from './automations';
import { coreStartup } from './core';
import { knowledgeWorkers } from './knowledge';
import { residualWorkers } from './residual';
import { runRegistry } from './registry';
import { valuationsWorkers } from './valuations';

function startup() {
  console.warn(`[startup] products: ${mountedProducts().join(', ')}`);

  if (mounts('core')) runRegistry(coreStartup);
  if (mounts('valuations')) runRegistry(valuationsWorkers);
  if (mounts('automations')) runRegistry(automationsWorkers);
  if (mounts('knowledge')) runRegistry(knowledgeWorkers);
  if (mounts('asks')) runRegistry(asksWorkers);
  if (mounts('residual')) runRegistry(residualWorkers);
}

export { startup };
