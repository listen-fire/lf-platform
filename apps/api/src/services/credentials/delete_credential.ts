// Deleting a credential, and forgetting what the process cached for it: the
// one path both the credentials page and lf (through the secrets module)
// take, so a row lf deletes is released at the provider exactly as one a
// person deletes.

import type { TeamId } from '../../generated/kysely/core/Team';

import { logger } from 'movement-engine/public/log';
import { getAutomationsQb } from '../../lib/kysely';
import { decryptToken } from '../../lib/credentials';
import { services } from '../../adapters/registry';
import { clearClientByCredentialsId } from '../../adapters/airtable/apiClient';
import { forgetGmailTokenClient } from '../../adapters/gmail/authClient';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { buildWebhookTargetUrl } from '../webhook_sync/urls';
import { credentialLifecycle } from './credential_lifecycle';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

/**
 * Drop the clients this process built over a credential's old tokens, after
 * the credential changed or went away.
 */
export function forgetCachedClients(type: ExternalServiceType, id: string): void {
  if (type === ExternalServiceType.GOOGLE) {
    services.google?.authClient.removeClient(id);
  } else if (type === ExternalServiceType.GOOGLE_GMAIL) {
    // Nothing is revoked at Google: under delegation there is no token at
    // all, and a sign-in's grant belongs to the account that made it, not to
    // a team's delete. What must go is the cached token client, or the next
    // connect under a reused id would reach for a dead token.
    forgetGmailTokenClient(id);
  } else if (type === ExternalServiceType.AIRTABLE) {
    clearClientByCredentialsId(id);
  }
}

/**
 * Delete one of `teamId`'s credentials: its cached clients, its webhooks at
 * the provider, its owned tokens, then the row. Throws when the team has no
 * such credential.
 */
export async function deleteCredential({ teamId, id }: { teamId: TeamId; id: ExternalServiceCredentialsId }): Promise<void> {
  const credential = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', id)
    .where('team_id', '=', teamId)
    .select(['id', 'type', 'credentials'])
    .executeTakeFirstOrThrow();

  forgetCachedClients(credential.type, credential.id);

  // Best-effort source-side webhook deregistration. The
  // `webhook_subscription` rows themselves go away with the
  // credential (FK ON DELETE CASCADE), but the provider keeps
  // posting at a dead URL unless its external registration is
  // removed — and that removal needs the credential to still
  // authenticate, so it has to happen before the row is deleted.
  // Mirrors the listen-reconciliation teardown: failures never
  // block the delete (a dangling source-side webhook posts at a
  // row that no longer verifies, and is removable by hand).
  const webhookSubscriptions = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('credentials_id', '=', credential.id)
    .where('deleted_at', 'is', null)
    .select(['id', 'provider', 'external_webhook_id'])
    .execute();
  for (const subscription of webhookSubscriptions) {
    try {
      const adapter = await resolveAdapter({
        adapterType: subscription.provider,
        teamId,
        credentialsId: credential.id,
      });
      if (typeof adapter.removeEventSubscription === 'function') {
        await adapter.removeEventSubscription({
          callbackUrl: buildWebhookTargetUrl(subscription.provider, subscription.id),
          ...(subscription.external_webhook_id !== null
            ? { externalId: subscription.external_webhook_id }
            : {}),
        });
      }
    } catch (err) {
      logger.warn('[credentials] webhook deregistration failed on delete', {
        subscriptionId: subscription.id,
        provider: subscription.provider,
        err,
      });
    }
  }

  // Owned-token teardown (Attio / Listen-Fire Valuations) — release any
  // external token tied to this credential before the row goes away.
  const deleteLifecycle = credentialLifecycle(credential.type);
  if (deleteLifecycle?.onDelete) {
    try {
      const decrypted = await decryptToken(credential.credentials, credential.id);
      await deleteLifecycle.onDelete({
        credentials: JSON.parse(decrypted),
        teamId,
      });
    } catch (err) {
      logger.warn('[credentials] owned-token teardown failed on delete', { err });
    }
  }

  await getAutomationsQb(['external_service_credentials'])
    .deleteFrom('external_service_credentials')
    .where('id', '=', id)
    .where('team_id', '=', teamId)
    .execute();
}
