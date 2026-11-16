// The module a webhook provider key's deliveries are read by, resolved as the
// webhook door resolves it, so whatever reads a kept delivery later (why it did
// not fire, run with it, who may see it) names the module the door did. A
// subscription stores its provider key (`SLACK`, `INBOUND_WHATSAPP`, a remote
// install's upper-cased slug); a listen is filed under its module (`slack`).

import type { TeamId } from '../../generated/kysely/core/Team';

import { getWebhookProvider } from './providers';
import { webhookProviderKey } from './urls';
import { hasAdapter, resolveAdapterSlug } from '../translation_graph/adapters/registry';
import { listRemoteAdapters, type RemoteAdapterRow } from '../translation_graph/adapters/remote/store';
import { mayBeRemoteSlug } from '../translation_graph/adapters/remote/slugs';

/** The built-in module behind `providerKey`, or null when no built-in provider has that key. Provider
 *  keys are trigger-kind aliases (each appears in its adapter's manifest `triggerKinds`), so the
 *  registry's alias map is the resolver, never a naming convention. */
export function builtInAdapterOfProvider(providerKey: string): string | null {
  if (getWebhookProvider(providerKey) === null) return null;
  const adapterType = resolveAdapterSlug(providerKey);
  return hasAdapter(adapterType) ? adapterType : null;
}

/**
 * The team's remote install that mints `providerKey` (`webhookProviderKey`). An
 * install whose slug a built-in answers to is never recognised (the shared rule
 * in `remote/slugs`): the built-in wins, as it does at resolution.
 */
export async function remoteInstallOfProvider(input: { teamId: TeamId; providerKey: string }): Promise<RemoteAdapterRow | null> {
  const installs = await listRemoteAdapters({ teamId: input.teamId });
  return installs.find((row) => mayBeRemoteSlug(row.adapter_type) && webhookProviderKey({ adapterType: row.adapter_type }) === input.providerKey) ?? null;
}

/** The module that reads `providerKey`'s deliveries for `teamId`; null when no door reads that key. */
export async function adapterTypeOfProvider(input: { teamId: TeamId; providerKey: string }): Promise<string | null> {
  if (getWebhookProvider(input.providerKey) !== null) return builtInAdapterOfProvider(input.providerKey);
  return (await remoteInstallOfProvider(input))?.adapter_type ?? null;
}
