// What 0.12's manifest of a module says, for the platform's listens.

import type { AdapterManifest } from '@listen-fire/engine/public/adapter';

import { manifestsOf } from './manifests';
import type { ModulePlatform } from './run_types';

export function manifestOf(adapterType: string, modules: ModulePlatform): AdapterManifest | undefined {
  const { kgChangeWebhooks, whatsappNumber } = modules.parts;
  return manifestsOf({ kgChangeWebhooks, whatsappNumber, mcpEnabled: true }).find((manifest) => manifest.adapterType === adapterType);
}
