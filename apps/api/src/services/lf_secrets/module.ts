// The platform as lf's secrets module: the secrets slot's nine methods
// (docs/contracts/secrets-slot.md in the language repository) over one team's
// encrypted `external_service_credentials` rows. lf names a credential by the
// row's name; every query here is that team's and that name's. lf gets
// fields, never ciphertext, and the master key never leaves this process:
// `list` hashes the ciphertext in SQL without decrypting it, and the version
// it answers is the one `resolve` and `writeBack` use (secrets_postgres.ts).
// Rows lf creates are the rows the platform's own connect pages write.

import { z } from 'zod';
import { sql } from 'kysely';
import { SECRETS_METHODS } from 'engine-contracts/slots';
import { SlotRefusal } from 'movement-engine/public/module-wire';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { decryptToken, encryptToken } from '../../lib/credentials';
import { getAutomationsQb } from '../../lib/kysely';
import { CredentialNameTakenError, persistCredential } from '../credentials/persist_credential';
import { credentialLifecycle } from '../credentials/credential_lifecycle';
import { deleteCredential, forgetCachedClients } from '../credentials/delete_credential';
import { postgresSecrets, type PayloadShape } from '../credentials/secrets_postgres';
import { lockLease, unlockLease } from './lease';
import { servedCredentials, wireReading, wireTarget, type WireTarget } from './rows';

export type SecretsMethod = (typeof SECRETS_METHODS)[number];

/** Each method, its params as lf sent them; the answer as the wire carries it. */
export type PlatformSecretsModule = Record<SecretsMethod, (params: unknown) => Promise<unknown>>;

const Ref = z.object({ ref: z.string().min(1) });
const Fields = z.record(z.string(), z.string());
const WriteBack = Ref.extend({ fields: Fields, expectedVersion: z.string() });
const Lock = Ref.extend({ ttlMs: z.number().int().nonnegative() });
const Unlock = Ref.extend({ token: z.string() });
const BindingShape = z.union([z.literal('install'), z.literal('legacy'), z.object({ credential: z.string().min(1) })]);
const Entry = Ref.extend({ external: z.string().min(1), binding: BindingShape, fields: Fields });

function parse<T>(shape: z.ZodType<T>, method: SecretsMethod, params: unknown): T {
  const parsed = shape.safeParse(params);
  if (!parsed.success) throw new SlotRefusal('bad_request', `${method}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

type StoredPayload = Record<string, unknown>;

function isPayload(value: unknown): value is StoredPayload {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether lf's fields set stored key `key`: the shape reads it as a field and
 *  writes that field back under the same key. A key lf does not set (a remote
 *  install's `oauthClients`, Gmail's granted scopes) survives a replace. */
function lfSetsKey(shape: PayloadShape, key: string, value: unknown): boolean {
  const baseline = shape.toFields({});
  const read = shape.toFields({ [key]: value });
  const fields = Object.fromEntries(Object.entries(read).filter(([field, text]) => baseline[field] !== text));
  if (Object.keys(fields).length === 0) return false;
  try {
    return Object.hasOwn(shape.withFields({}, fields), key);
  } catch {
    return false;
  }
}

/** The SLACK row's identifier, as the connect flows derive it. */
function slackIdentifier(type: ExternalServiceType, payload: StoredPayload): string | null {
  if (type !== ExternalServiceType.SLACK) return null;
  if (typeof payload.teamId === 'string' && payload.teamId !== '') return `teamId:${payload.teamId}`;
  if (typeof payload.enterpriseId === 'string' && payload.enterpriseId !== '') return `enterpriseId:${payload.enterpriseId}`;
  return null;
}

export function platformSecretsModule({ teamId, userId }: { teamId: TeamId; userId: UserId | null }): PlatformSecretsModule {
  const credentials = () => getAutomationsQb(['external_service_credentials']);

  /** The team's row named `ref`, whatever it is. */
  const rowNamed = (ref: string) =>
    credentials()
      .selectFrom('external_service_credentials')
      .where('team_id', '=', teamId)
      .where('name', '=', ref)
      .select(['id', 'type', 'app_id', 'declared_credential', 'wire_binding', sql<boolean>`credentials IS NULL`.as('shell')])
      .executeTakeFirst();

  /** The row named `ref` as lf reads it: absent when there is none, it is a
   *  shell, or lf is not served its kind. */
  const servedRow = async (ref: string) => {
    const row = await rowNamed(ref);
    if (row === undefined || row.shell) return undefined;
    const reading = wireReading(row);
    return reading === null ? undefined : { id: row.id, shape: reading.shape };
  };

  const create = async (ref: string, target: WireTarget, fields: Record<string, string>): Promise<null> => {
    try {
      await persistCredential({
        teamId,
        userId,
        name: ref,
        type: target.type,
        credentials: target.shape.withFields({}, fields),
        appId: target.appId,
        ...(target.declaredCredential !== null ? { declaredCredential: target.declaredCredential } : {}),
        ...(target.wireBinding !== null ? { wireBinding: target.wireBinding } : {}),
      });
    } catch (error) {
      if (error instanceof CredentialNameTakenError) throw new SlotRefusal('exists', `the platform already keeps a credential named "${ref}"`);
      throw error;
    }
    return null;
  };

  /** Rewrite the row in place: same id, so what points at it (triggers,
   *  webhook subscriptions, installs) still does. */
  const replaceInPlace = async (
    row: { id: ExternalServiceCredentialsId; type: ExternalServiceType; shell: boolean },
    target: WireTarget,
    fields: Record<string, string>,
  ): Promise<null> => {
    let prior: StoredPayload = {};
    if (!row.shell) {
      const stored = await credentials()
        .selectFrom('external_service_credentials')
        .where('id', '=', row.id)
        .where('team_id', '=', teamId)
        .select(['credentials'])
        .executeTakeFirstOrThrow();
      const parsed: unknown = JSON.parse(await decryptToken(stored.credentials, row.id));
      if (isPayload(parsed)) prior = parsed;
    }
    const kept = Object.fromEntries(Object.entries(prior).filter(([key, value]) => typeof value !== 'string' && !lfSetsKey(target.shape, key, value)));
    let next: unknown = target.shape.withFields(kept, fields);
    const lifecycle = credentialLifecycle(row.type);
    // A shell holds no token to release, so it is connected afresh.
    if (row.shell) {
      if (lifecycle?.onCreate) next = await lifecycle.onCreate({ credentials: next, teamId });
    } else if (lifecycle?.onUpdate) {
      next = await lifecycle.onUpdate({ credentials: next, teamId, prior });
    }
    await credentials()
      .updateTable('external_service_credentials')
      .set({
        credentials: await encryptToken(JSON.stringify(next), row.id),
        app_id: target.appId,
        declared_credential: target.declaredCredential,
        wire_binding: target.wireBinding,
        identifier: slackIdentifier(row.type, isPayload(next) ? next : {}),
        reconnect_required_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .where('team_id', '=', teamId)
      .execute();
    forgetCachedClients(row.type, row.id);
    return null;
  };

  return {
    async 'secrets.resolve'(params) {
      const { ref } = parse(Ref, 'secrets.resolve', params);
      const row = await servedRow(ref);
      if (row === undefined) return null;
      return postgresSecrets({ teamId, shape: row.shape }).resolve(row.id);
    },

    async 'secrets.writeBack'(params) {
      const { ref, fields, expectedVersion } = parse(WriteBack, 'secrets.writeBack', params);
      const row = await servedRow(ref);
      if (row === undefined) return { kind: 'missing' };
      return postgresSecrets({ teamId, shape: row.shape }).writeBack(row.id, fields, expectedVersion);
    },

    async 'secrets.list'() {
      return servedCredentials(teamId);
    },

    async 'secrets.lock'(params) {
      const { ref, ttlMs } = parse(Lock, 'secrets.lock', params);
      return lockLease({ teamId, ref, ttlMs });
    },

    async 'secrets.unlock'(params) {
      const { ref, token } = parse(Unlock, 'secrets.unlock', params);
      return unlockLease({ teamId, ref, token });
    },

    async 'secrets.assertWritable'(params) {
      parse(Ref, 'secrets.assertWritable', params);
      return null;
    },

    async 'secrets.create'(params) {
      const { ref, external, binding, fields } = parse(Entry, 'secrets.create', params);
      return create(ref, wireTarget({ external, binding }), fields);
    },

    async 'secrets.replace'(params) {
      const { ref, external, binding, fields } = parse(Entry, 'secrets.replace', params);
      const target = wireTarget({ external, binding });
      const row = await rowNamed(ref);
      if (row === undefined) return create(ref, target, fields);
      if (row.type !== target.type) {
        throw new SlotRefusal('type_change', `the platform keeps "${ref}" as a ${row.type} credential, and "${external}" would make it a ${target.type} one; delete it first`);
      }
      return replaceInPlace(row, target, fields);
    },

    async 'secrets.delete'(params) {
      const { ref } = parse(Ref, 'secrets.delete', params);
      const row = await rowNamed(ref);
      if (row === undefined || wireReading(row) === null) throw new SlotRefusal('missing', `the platform keeps no credential named "${ref}"`);
      await deleteCredential({ teamId, id: row.id });
      return null;
    },
  };
}
