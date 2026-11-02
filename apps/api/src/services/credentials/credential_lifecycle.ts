// Credential lifecycle — adapter-keyed hooks that run when an external-service
// credential is deleted.
//
// The concern today is the auto-minted api-key behind a Listen-Fire-owned
// credential (Valuations): deleting the credential revokes the key, so no usable
// token outlives the connection that minted it.
//
// Keyed by `ExternalServiceType` — the credential's type — so the credential
// router, the setup-agent router and the secrets module dispatch through one
// seam. Adapters with no lifecycle concern simply aren't in the registry (the
// hooks are no-ops for them).

import type { TeamId } from '../../generated/kysely/core/Team';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { nativeValuationsCredsParser } from '../translation_graph/adapters/native_valuations';
import { ApiKeyService } from '../api_key';

interface LifecycleContext {
  /** The decrypted credentials envelope this hook operates on. */
  credentials: unknown;
  teamId: TeamId;
}

interface CredentialLifecycle {
  /** Before the credential row is deleted — release any external/owned state. */
  onDelete(input: LifecycleContext): Promise<void>;
}

const LIFECYCLES: Partial<Record<ExternalServiceType, CredentialLifecycle>> = {
  [ExternalServiceType.NATIVE_VALUATIONS]: {
    // Mirror of the auto-mint in the credential router: revoke the underlying
    // api-key so we don't leave a usable token. Manually-wired integrations
    // with no apiKeyId (legacy / dev seed) have nothing to revoke.
    onDelete: async ({ credentials }) => {
      try {
        const prior = nativeValuationsCredsParser.parse(credentials);
        if (prior.apiKeyId) await ApiKeyService.revoke(prior.apiKeyId);
      } catch {
        // Best-effort — proceed with row deletion even if cleanup fails.
      }
    },
  },
};

/** The lifecycle hooks for a credential type, or undefined when it has none. */
export function credentialLifecycle(
  type: ExternalServiceType,
): CredentialLifecycle | undefined {
  return LIFECYCLES[type];
}
