import { isDeepStrictEqual } from 'node:util';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { RemoteAdapterManifestInput, type RemoteAdapterManifestFile } from '../../../services/translation_graph/adapters/remote/manifest';
import {
  deleteRemoteAdapter,
  getRemoteAdapter,
  listRemoteAdapters,
  parseStoredManifest,
  type RemoteAdapterRow,
} from '../../../services/translation_graph/adapters/remote/store';
import { installRemoteAdapterFromManifest } from '../../../services/translation_graph/adapters/remote/install';
import { GranteesInput } from '../../../services/access/stated_input';
import { useForNewConnection } from './connection_creation';
import { bindFlowToUser } from '../../../lib/oauthFlows';
import { CredentialNameTakenError } from '../../../services/credentials/persist_credential';
import {
  beginRemoteModuleSignIn,
  createStaticRemoteModuleCredential,
  listRemoteModuleCredentials,
  RemoteModuleCredentialRefused,
} from '../../../services/credentials/remote_module_connect';
import { EXEMPT, USE_CONNECTION, connectionUnseen, decidesEach, usableAmong } from '../../access_route';
import { getAutomationsQb } from '../../../lib/kysely';
import { userProcedure as sharedUserProcedure } from '../procedures';

/**
 * tRPC router for managing remote Translation Graph adapter installs.
 *
 * Wraps the team-scoped `remote_adapter` store from Phase 5a. The team id
 * always comes from the authed context (`currentContext().user.teamId`) — it
 * is never taken as untrusted input, so an install can only ever touch the
 * caller's own team. The manifest IS both the install artifact and the
 * editable record, so `upsertFromManifest` validates against the existing
 * `RemoteAdapterManifestInput` zod schema rather than redefining the shape.
 *
 * The encrypted credential never travels through here — only the
 * `credentialsId` FK into `external_service_credentials`, which is safe to
 * project back to the UI.
 *
 * tRPC + UI
 */
/**
 * One list row. The display metadata + trigger/method capabilities live only in
 * the manifest jsonb, so the row is re-parsed; a manifest that no longer parses
 * becomes an `invalid` entry (still deletable) rather than failing the list.
 */
export function toListEntry(row: RemoteAdapterRow) {
  const id = row.id as unknown as string;
  const stored = parseStoredManifest(row);
  if (!stored.ok) {
    return { kind: 'invalid' as const, id, adapterType: row.adapter_type, reason: stored.reason };
  }
  const { manifest } = stored;
  return {
    kind: 'valid' as const,
    id,
    adapterType: row.adapter_type,
    displayName: manifest.displayName ?? null,
    description: manifest.description ?? null,
    supportedTriggers: manifest.supportedTriggers,
    methods: manifest.methods,
    baseUrl: row.base_url,
    authStrategy: row.auth_strategy,
    credentialsId: (row.credentials_id as unknown as string | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A refusal from the credential service, as the caller reads it. */
async function reportingRefusals<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RemoteModuleCredentialRefused) throw new TRPCError({ code: error.code, message: error.message });
    if (error instanceof CredentialNameTakenError) throw new TRPCError({ code: 'CONFLICT', message: error.message });
    throw error;
  }
}

const ModuleCredentialTarget = z.object({
  adapterType: z.string(),
  declaredCredential: z.string(),
  name: z.string().trim(),
});

/**
 * A manifest saved back with no secret keeps the secret the install holds,
 * rather than clearing it: the form never sees a secret its member may not use.
 * That secret authenticates to the install's server, so a member who may not
 * use it cannot repoint the install at another one.
 */
async function keepingInstallSecret(input: {
  teamId: TeamId;
  submitted: RemoteAdapterManifestInput;
  replacing: boolean;
}): Promise<RemoteAdapterManifestInput> {
  const { submitted } = input;
  if (input.replacing || submitted.credentialsId !== undefined) return submitted;
  const held = await getRemoteAdapter({ teamId: input.teamId, adapterType: submitted.adapterType });
  if (held === null || held.credentials_id === null) return submitted;
  const heldId = held.credentials_id as unknown as string;
  const sameServer = held.base_url === submitted.baseUrl && isDeepStrictEqual(held.auth_strategy, submitted.authStrategy);
  if (!sameServer && (await connectionUnseen(heldId))) {
    throw new TRPCError({ code: 'CONFLICT', message: 'This module is connected with a connection you may not use, so its address and sign-in cannot change.' });
  }
  return { ...submitted, credentialsId: heldId };
}

const remoteAdapterRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /**
     * List the remote adapters installed for the caller's team. Projects
     * each row to a UI-friendly summary — the scalar routing columns plus
     * the install timestamps. No encrypted secret is stored on the row;
     * `credentialsId` is just the FK, safe to surface.
     */
    list: userProcedure.query(async () => {
      const ctx = currentContext();
      const rows = await listRemoteAdapters({
        teamId: ctx.user.teamId as TeamId,
      });
      // An install's own secret is a connection: one the caller may not use is shown as not connected.
      const usable = new Set(
        await usableAmong(
          rows.flatMap((row) => (row.credentials_id === null ? [] : [row.credentials_id as unknown as string])),
          { connectionOf: (id) => id, teamIds: [ctx.user.teamId] },
        ),
      );
      return rows
        .map((row) =>
          row.credentials_id === null || usable.has(row.credentials_id as unknown as string) ? row : { ...row, credentials_id: null },
        )
        .map(toListEntry);
    }),

    /**
     * Fetch a single installed adapter by slug, reconstructed back into its
     * full manifest shape (the editable record the UI form binds to).
     * Returns `null` when the team has no install under that slug.
     */
    get: userProcedure
      .input(z.object({ adapterType: z.string() }))
      .query(async ({ input }): Promise<RemoteAdapterManifestFile | null> => {
        const ctx = currentContext();
        const row = await getRemoteAdapter({
          teamId: ctx.user.teamId as TeamId,
          adapterType: input.adapterType,
        });
        if (!row) return null;
        const stored = parseStoredManifest(row);
        if (!stored.ok) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `The stored manifest for "${input.adapterType}" is no longer valid: ${stored.reason}`,
          });
        }
        // As in `list`, an install's secret the caller may not use reads as no secret. A form saving this back
        // omits it, and `upsertFromManifest` keeps what the install holds.
        const { credentialsId, ...unconnected } = stored.manifest;
        return credentialsId === undefined || !(await connectionUnseen(credentialsId)) ? stored.manifest : unconnected;
      }),

    /**
     * Install or update a remote adapter from a manifest file. Upserts on
     * `(team_id, adapter_type)` — re-importing the same slug edits the
     * existing install rather than creating a duplicate. The input is the
     * manifest (canonical `RemoteAdapterManifestInput` schema) plus an OPTIONAL
     * `secret`: when present, the adapter's auth secret is minted into an
     * encrypted `REMOTE` credential (bound to the slug) and linked in the same
     * step — install and connect are one felt action. The secret never enters
     * the stored manifest. Omit it to install now and connect the secret later
     * via the connect link. The protocol version is asked of the server with
     * the new secret, or the stored one on an edit; the form never claims it.
     */
    upsertFromManifest: userProcedure
      .input(RemoteAdapterManifestInput.extend({ secret: z.string().min(1).optional(), use: GranteesInput.optional() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const { secret, use: givenUse, ...manifest } = input;
        // The install authenticates to the manifest's server with its secret,
        // so naming a connection here hands it over: it needs use of it.
        if (manifest.credentialsId !== undefined && (await connectionUnseen(manifest.credentialsId))) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `No connection ${manifest.credentialsId}.` });
        }
        // A new secret rotates the connection already under the install's name.
        if (secret !== undefined) {
          const name = manifest.displayName ?? manifest.adapterType;
          const rotated = await getAutomationsQb(['external_service_credentials'])
            .selectFrom('external_service_credentials')
            .where('team_id', '=', ctx.user.teamId as TeamId)
            .where('name', '=', name)
            .select(['id'])
            .executeTakeFirst();
          if (rotated !== undefined && (await connectionUnseen(rotated.id))) {
            throw new TRPCError({ code: 'CONFLICT', message: `The name "${name}" is taken by a connection you may not use; choose another name.` });
          }
        }
        // A new secret is minted into a connection of its own, whose users are asked for.
        const use = secret !== undefined ? await useForNewConnection({ teamId: ctx.user.teamId, use: givenUse }) : undefined;
        return installRemoteAdapterFromManifest({
          teamId: ctx.user.teamId as TeamId,
          userId: ctx.user.id as UserId,
          manifest: await keepingInstallSecret({ teamId: ctx.user.teamId as TeamId, submitted: manifest, replacing: secret !== undefined }),
          ...(secret !== undefined ? { secret, use } : {}),
        });
      }),

    /**
     * What one installed module declares as provider credentials, with the
     * fields a member fills (each only flagged secret or optional, never a
     * value) and the credentials already created for each declaration.
     */
    credentials: userProcedure
      .input(z.object({ adapterType: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const listed = await reportingRefusals(() =>
          listRemoteModuleCredentials({ teamId: ctx.user.teamId as TeamId, adapterType: input.adapterType }),
        );
        return {
          ...listed,
          declarations: await Promise.all(
            listed.declarations.map(async (declaration) => ({
              ...declaration,
              credentials: await usableAmong(declaration.credentials, { connectionOf: (c) => c.id, teamIds: [ctx.user.teamId] }),
            })),
          ),
        };
      }),

    /**
     * Create a member's provider credential for a `static` declaration from
     * the fields they entered. Refuses a field the declaration does not list,
     * a required one left out, and a name a movement could not import.
     */
    createStaticCredential: userProcedure
      .input(ModuleCredentialTarget.extend({ fields: z.record(z.string(), z.string()), use: GranteesInput.optional() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const use = await useForNewConnection({ teamId: ctx.user.teamId, use: input.use });
        return reportingRefusals(() =>
          createStaticRemoteModuleCredential({
            ...input,
            use,
            teamId: ctx.user.teamId as TeamId,
            userId: ctx.user.id as UserId,
          }),
        );
      }),

    /**
     * Begin a member's sign-in at the provider for an `oauth2` declaration,
     * through the install's OAuth app for it; returns the authorize URL. The
     * callback route completes it and stores the tokens. Refuses when the
     * install holds no OAuth app for the declaration.
     */
    beginOAuthCredential: userProcedure
      .input(ModuleCredentialTarget.extend({ fields: z.record(z.string(), z.string()).optional(), use: GranteesInput.optional() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        // Decided now: the provider's callback that stores the credential has no caller.
        const use = await useForNewConnection({ teamId: ctx.user.teamId, use: input.use });
        const { url, state } = await reportingRefusals(() =>
          beginRemoteModuleSignIn({
            ...input,
            use,
            teamId: ctx.user.teamId as TeamId,
            userId: ctx.user.id as UserId,
          }),
        );
        bindFlowToUser(state, ctx.user.id);
        return { url };
      }),

    /**
     * Uninstall a remote adapter for the caller's team. Idempotent — a
     * missing slug is a no-op (the team-scoped DELETE simply matches zero
     * rows).
     */
    delete: userProcedure
      .input(z.object({ adapterType: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await deleteRemoteAdapter({
          teamId: ctx.user.teamId as TeamId,
          adapterType: input.adapterType,
        });
        return { success: true };
      }),
  });
};

decidesEach('remoteAdapter', {
  list: USE_CONNECTION,
  get: EXEMPT.teamCatalog,
  upsertFromManifest: USE_CONNECTION,
  credentials: USE_CONNECTION,
  createStaticCredential: EXEMPT.newConnection,
  beginOAuthCredential: EXEMPT.newConnection,
  delete: { exempt: 'uninstalls a module of the team catalog; its connections stay' },
});

export { remoteAdapterRouter };
