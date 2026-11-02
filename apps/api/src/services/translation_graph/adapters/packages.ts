// What a package adds beyond its adapter, beside the registry of adapters.
//
// An adapter package may bring the run host more than an adapter: work kinds
// of its own (a sweep, a subscription refresh), the landing types its writes
// synthesise. The run host reaches
// each through these lookups and names no package. Read at call time, never at
// load, so a package module mid-load in an import cycle is never captured
// half-built.

import type { WorkKindRegistration } from '../../work/drain';
import type { LandingSynthesizer } from '../movement/generic_landings';

import { AIRTABLE_WORK_KINDS } from '../../airtable_webhook_refresh/worker';
import { ASK_ADAPTER_TYPE } from '@listen-fire/ask/types';
import { askResponseDescriptorFor } from '@listen-fire/ask/descriptors';
import { ASK_WORK_KINDS } from '../../asks/closed_sweep';
import { builtinModuleWorkKinds } from './builtin_modules';


/** Every package's own work kinds, for the process that drains: the legacy
 *  packages' by name, and each module line's declared periodic tasks. */
export function adapterWorkKinds(): WorkKindRegistration[] {
  return [...ASK_WORK_KINDS, ...AIRTABLE_WORK_KINDS, ...builtinModuleWorkKinds()];
}

/** What an adapter type's generic landings are, given the literals a write
 *  authored — for an adapter whose edges declare `genericOver`. */
export function landingSynthesizerFor(adapterType: string): LandingSynthesizer | undefined {
  if (adapterType !== ASK_ADAPTER_TYPE) return undefined;
  return ({ writtenType, values }) => askResponseDescriptorFor({ family: writtenType, values });
}
