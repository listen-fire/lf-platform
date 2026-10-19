// Listen-Fire Valuations' legacy line: the module's adapter
// (@lf/native-valuations), over the credential path the platform used before
// modules (the row read and decrypted here; the platform's own address when
// the row names none). Kept so the `BUILTIN_MODULES` line for Valuations can go
// back to `legacy` in one edit while the module line is new; remove it with
// the line once the module line has soaked. The Settings provider opens the
// API the same way, so it stays here when the line goes.

import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { Adapter } from 'movement-engine/public/adapter';

import { NativeValuationsAdapter, valuationsApiFrom, type ValuationsApi } from '@listen-fire/native-valuations';
import { logger } from 'movement-engine/public/log';
import { getAutomationsQb } from '../../../lib/kysely';
import { apiBaseUrl } from '../../../lib/api_base_url';
import { decryptToken } from '../../../lib/credentials';

export * from '@listen-fire/native-valuations/credential';
export * from '@listen-fire/native-valuations/manifest';
export * from '@listen-fire/native-valuations/types';

/** The API a stored Valuations credential opens: its key, at its own base URL
 *  or else the platform's address. */
export async function platformValuationsApi(credentialsId: string): Promise<ValuationsApi> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  const stored = z.record(z.string(), z.unknown()).parse(JSON.parse(await decryptToken(row.credentials, credentialsId)));
  const api = valuationsApiFrom({ ...stored, baseUrl: stored.baseUrl ?? apiBaseUrl() }, { fetch });
  if (api === null) throw new Error(`Listen-Fire Valuations credentials ${credentialsId} hold no api-key.`);
  return api;
}

export function createNativeValuationsAdapter(input: { teamId: TeamId; credentialsId?: string }): Adapter {
  const { credentialsId } = input;
  return new NativeValuationsAdapter({
    api: async () => (credentialsId === undefined ? null : platformValuationsApi(credentialsId)),
    log: logger,
  });
}
