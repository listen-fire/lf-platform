/**
 * tRPC surface for the unified `/connections` page (U5).
 *
 * Merges the data previously split across `/integrations`, `/sources`,
 * and `/destinations` into a single page payload, with the read/write
 * semantics derived at view time so the user can answer "is Attio
 * being read from, written to, or both?" without spelunking through
 * each automation.
 *
 *   Reads-from = at least one `automations.trigger` has
 *                `credentials_id = <this credential>`
 *   Writes-to  = at least one `knowledge.translation_graph` body has
 *                `targetSchemaRef.credentialsId = <this credential>`
 *
 * The same trigger/TG rows feed the per-row "Used by X automations"
 * counts: an automation = a trigger, so the count is the union of
 * triggers reading the credential and triggers whose orchestrations
 * run a TG that writes to the credential.
 *
 */


import { TRPCError } from '@trpc/server';
import { currentPrincipal } from 'principal';
import { z } from 'zod';

import type { UserId } from '../../../generated/kysely/core/User';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getQb, getAutomationsQb } from '../../../lib/kysely';
import { userProcedure as sharedUserProcedure } from '../procedures';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { movementsImportingCredential } from '../../../services/connections/credential_dependents';
import { resolveAdapterSlug } from '../../../services/translation_graph/adapters/registry';
import { teamAdapterManifests } from '../../../services/translation_graph/adapters/team_manifests';
import { listRemoteAdapters } from '../../../services/translation_graph/adapters/remote/store';
import { loadCredentialRows } from '../../../services/translation_graph/movement/catalog';
import { callerAudience } from '../../../services/translation_graph/movement/audience';
import { credentialImportNames } from 'movement-engine/public/catalog';
import { connectWrittenAs } from '../../../services/translation_graph/adapters/builtin_modules';
import { inboundRoutingAddress } from '@listen-fire/email';
import { WHATSAPP_MOVEMENTS_NUMBER } from '../../../services/translation_graph/adapters/whatsapp';
import {
  builtInBotUsername,
  ensureSharedTelegramTeamCredential,
  mintTelegramToken,
  telegramStartUrl,
} from '../../../services/translation_graph/adapters/telegram/handshake';
import { USE_CONNECTION, connectionUnseen, decidesEach, readableAmong, seenAmong } from '../../access_route';
import { seenOnlyBy } from '../../../services/access/decide';
import { librariesSharingConnections } from '../../../services/access/library_sharing';
import { GranteesInput } from '../../../services/access/stated_input';
import { useForNewConnection } from './connection_creation';


/** Hide seed labels that leaked into the dev-loop DB before U1's seed rename. */
const DEV_FIXTURE_NAME_RE = /^(Test |Dev Loop |Mock )/i;

export type ConnectionsIntegration = {
  locked: false;
  id: string;
  name: string;
  type: string;
  reads: boolean;
  writes: boolean;
  automationCount: number;
  /**
   * The names a program connects with this credential under —
   * ``connect `@lf/attio` using <name>``. Computed with the movement
   * catalog's own projection (`credentialImportNames`) so the page shows
   * exactly what the language resolves. Usually one entry; several when
   * one credential type serves multiple adapters (e.g. a Google account
   * powering both Sheets and Drive); empty when no adapter can use the
   * credential from a program.
   */
  importNames: string[];
  /** Each `connect` a program writes with this credential: one per module
   *  the credential's type connects, under each of its names. */
  connectLines: string[];
  /** Whether only the caller may use it. */
  onlyYou: boolean;
  /** The libraries (files that export) that name it, so it is shared through them with those who may use the library: derived each time, never stored on the connection. */
  sharedThrough: string[];
};

/** A connection a team admin may not use, shown by its name alone: its list is its access panel's. */
export type LockedConnection = { locked: true; id: string; name: string };

export type ConnectionsSourceChannel = {
  /** Stable key matching the trigger.kind for this built-in receiver. */
  kind: string;
  name: string;
  identifier: string;
  automationCount: number;
};

export type ConnectionsCustomRow = {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  configSummary: string;
};

export type ConnectionsPayload = {
  integrations: (ConnectionsIntegration | LockedConnection)[];
  sourceChannels: ConnectionsSourceChannel[];
  custom: ConnectionsCustomRow[];
};

/**
 * Everything that would be affected by deleting one credential — the
 * payload behind the delete-confirmation dialog. Enumerated honestly
 * from the schema and the movement TEXT:
 *
 *   - `movements` — saved movement files whose source imports one of the
 *     credential's import names (`import { <name> } from credentials`).
 *     No FK exists (the TEXT is canonical); re-derived by scanning each
 *     team source, the same posture as movement file dependents. These
 *     break loud: their next check/save/run fails on the unresolved
 *     import.
 *   - `automations` — `automations.trigger` rows with
 *     `credentials_id = <this credential>`. The delete releases them
 *     (the vault's in-schema ON DELETE SET NULL), so the trigger row
 *     survives but stops matching inbound events — silent at the database
 *     layer, which is exactly why the dialog lists them by name before
 *     the user confirms.
 *   - `webhookSubscriptionCount` — `automations.webhook_subscription` rows
 *     (ON DELETE CASCADE: they go away with the credential). The
 *     source-side registration is deregistered best-effort on delete.
 *   - `remoteAdapterCount` — the remaining `credentials_id` FK in the
 *     schema (`remote_adapter`), ON DELETE SET NULL. Surfaced as a count
 *     so the dialog never hides a reference.
 */
export type CredentialDependentsPayload = {
  importNames: string[];
  movements: { id: string; name: string; validityStatus: string | null }[];
  automations: { id: string; name: string }[];
  webhookSubscriptionCount: number;
  remoteAdapterCount: number;
};

/**
 * Built-in source channels. Mirrors the BUILT_IN_SOURCES list on the
 * legacy `/sources` page — kept in lockstep so this view can derive
 * automation counts purely from trigger.kind without joining
 * pipeline_input. Identifiers are the human-readable handles the user
 * hands out (the address the system listens on), not internal slugs.
 *
 * The email and WhatsApp ones are the DEPLOYMENT's own inbound address and
 * number, because that is what a user would be told to write to.
 */
/** Each `connect` a program writes with one credential: under each name it
 *  is imported by, one per module the language binds that name to (a team
 *  module's provider credential binds its module alone); and, for the server
 *  secret a team module was installed with, that module's own connect, which
 *  names no credential (installed is connected). */
function connectLinesOf(credential: {
  imported: readonly { name: string; adapters: readonly string[] }[];
  secretOf: readonly string[];
}): string[] {
  const using = credential.imported.flatMap(({ name, adapters }) =>
    adapters.flatMap((adapter) => {
      const module = connectWrittenAs(adapter);
      return module === undefined ? [] : [`connect ${module} using ${name}`];
    }),
  );
  const installed = credential.secretOf.flatMap((adapter) => {
    const module = connectWrittenAs(adapter);
    return module === undefined ? [] : [`connect ${module}`];
  });
  return [...using, ...installed];
}

function builtInChannels(): ConnectionsSourceChannel[] {
  const address = inboundRoutingAddress();
  return [
    {
      kind: 'INBOUND_EMAIL',
      name: 'Email',
      identifier: address === null ? 'no inbound address configured' : `${address.localPart}@${address.domain}`,
      automationCount: 0,
    },
    {
      kind: 'INBOUND_WHATSAPP',
      name: 'WhatsApp',
      identifier: WHATSAPP_MOVEMENTS_NUMBER ?? 'no WhatsApp number configured',
      automationCount: 0,
    },
    { kind: 'WEB', name: 'Web upload', identifier: 'Upload via the UI', automationCount: 0 },
  ];
}

const BUILT_IN_CHANNELS: ConnectionsSourceChannel[] = builtInChannels();

/**
 * Trigger kinds that are themselves first-class entries on the page,
 * either as built-in source channels (above) or as integration-credential
 * usages. Any other kind shows up in the "Custom" section so the page
 * never silently drops a configured automation source.
 */
const FIRST_CLASS_KINDS = new Set<string>([
  ...BUILT_IN_CHANNELS.map((c) => c.kind),
  // Integration-credentialled kinds — these triggers also pin a
  // credentials_id, so they're attributed to the integration row.
  // Listed explicitly so the "custom" fallback stays narrow.
  'MAILGUN',
  'CUSTOM_EMAIL',
  'TWILIO',
  'SLACK',
  'ATTIO',
  'AFFINITY',
  'AIRTABLE',
  'GMAIL',
  'GRANOLA',
  'EVERTRACE',
  'DEALROOM',
  'NATIVE_VALUATIONS',
  'CHROME_EXTENSION',
  'API',
  'KG_MUTATION',
]);


const KIND_LABELS: Record<string, string> = {
  MAILGUN: 'Email',
  CUSTOM_EMAIL: 'Email',
  INBOUND_EMAIL: 'Email',
  GMAIL: 'Email',
  TWILIO: 'WhatsApp',
  INBOUND_WHATSAPP: 'WhatsApp',
  SLACK: 'Slack',
  AIRTABLE: 'Airtable',
  ATTIO: 'Webhook',
  AFFINITY: 'Webhook',
  API: 'API',
  WEB: 'Web',
  CHROME_EXTENSION: 'Chrome',
  WEB_QUESTION: 'Question',
  GRANOLA: 'Granola',
  EVERTRACE: 'Evertrace',
  DEALROOM: 'Dealroom',
  NATIVE_VALUATIONS: 'Listen-Fire Valuations',
  KG_MUTATION: 'Knowledge change',
};

function kindToLabel(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  return kind
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function summariseConfig(config: unknown): string {
  if (!config || typeof config !== 'object') return '';
  const obj = config as Record<string, unknown>;
  if (typeof obj.key === 'string' && obj.key.length > 0) {
    return `Tag: ${obj.key}`;
  }
  return '';
}

/**
 * What connecting the team to Telegram answers: the connection, or why it was
 * refused. A refusal is a result with a reason of its own, so the page tells
 * them apart by the reason and never by text written for agents.
 *   - `needs_use`: the team has no Telegram connection and no statement of who
 *     may use the one this would create.
 *   - `not_usable`: the connection exists and the caller may not use it.
 *   - `given_for_existing`: a use list was given for a connection that exists,
 *     where it would not be applied.
 */
type TelegramTeamConnect =
  | { ok: true; id: string; name: string; created: boolean }
  | { ok: false; reason: 'needs_use' | 'not_usable' | 'given_for_existing' };

const connectionsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /**
     * One-shot fetch of everything the /connections page renders:
     * integrations with their read/write derivation, source channels
     * with usage counts, and any custom (non-first-class) trigger
     * configurations. Internal joins live here so the page component
     * stays a dumb renderer.
     */
    getAll: userProcedure.query(async (): Promise<ConnectionsPayload> => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;
      const isProd = process.env.NODE_ENV === 'production';

      // Pull the tables in parallel — none depend on each other.
      const [teamCredentialRows, teamTriggerRows, manifests, catalogCredentialRows, remoteInstalls] =
        await Promise.all([
          getAutomationsQb(['external_service_credentials'])
            .selectFrom('external_service_credentials')
            .where('team_id', '=', teamId)
            .select(['id', 'name', 'type'])
            .orderBy('name', 'asc')
            .execute(),
          getAutomationsQb(['trigger'])
            .selectFrom('trigger')
            .where('team_id', '=', teamId)
            .select(['id', 'name', 'kind', 'config', 'credentials_id', 'movement_id'])
            .execute(),
          // The catalog's own manifests and credential rows, so the page
          // shows exactly what the language resolves, the team's own modules
          // (`#acme_crm`) among them.
          teamAdapterManifests(teamId, []),
          // Only names the rows below; the one filter on what the page lists is `seenAmong`, and a
          // row's import name is its own, so a row left out here is never looked up.
          loadCredentialRows(teamId, { for: 'run' }),
          listRemoteAdapters({ teamId }),
        ]);
      // The page shows the connections the caller may use, and the listens of
      // the automations they may read; an admin also sees every other
      // connection on the team, by name alone.
      const seenCredentials = (
        await seenAmong(teamCredentialRows, { thing: 'connection', idOf: (c) => String(c.id), teamId })
      ).filter(({ item }) => isProd || !DEV_FIXTURE_NAME_RE.test(item.name));
      const credentialRows = seenCredentials.flatMap(({ item, locked }) => (locked ? [] : [item]));
      const triggerRows = await readableAmong(teamTriggerRows, { automationOf: (t) => t.movement_id, teamIds: [teamId] });
      const onlyYours = await seenOnlyBy(currentPrincipal(), {
        thing: 'connection',
        teamId,
        ids: credentialRows.map((c) => String(c.id)),
      });

      // Movement import names for each credential row — the identifier a
      // program writes in `import { … } from credentials`. Reuses the
      // movement catalog's exact projection so the page can never disagree
      // with what the language resolves.
      const credentialsByImportName = credentialImportNames({ rows: catalogCredentialRows, manifests });
      const importedByCredentialId = new Map<string, { name: string; adapters: readonly string[] }[]>();
      for (const [importName, row] of Object.entries(credentialsByImportName)) {
        const list = importedByCredentialId.get(row.id) ?? [];
        list.push({ name: importName, adapters: row.adapters });
        importedByCredentialId.set(row.id, list);
      }
      const sharedThrough = await librariesSharingConnections(currentPrincipal(), teamId);
      const installsBySecretId = new Map<string, string[]>();
      for (const install of remoteInstalls) {
        const secretId = install.credentials_id as unknown as string | null;
        if (secretId === null) continue;
        installsBySecretId.set(secretId, [...(installsBySecretId.get(secretId) ?? []), install.adapter_type]);
      }

      const integrations = seenCredentials.map(({ item: c, locked }): ConnectionsIntegration | LockedConnection => {
        const credId = c.id as unknown as string;
        if (locked) return { locked: true, id: credId, name: c.name };
        // A credential's automations are the triggers bound to it (a
        // movement listens to its credentialed source). Read/write
        // attribution lived in TG bodies (retired, kill-tg phase 6) and
        // now lives in the movement source, so it isn't cheaply derivable
        // here; report the binding as a read.
        const boundTriggers = triggerRows
          .filter((t) => (t.credentials_id as unknown as string | null) === credId)
          .map((t) => t.id as unknown as string);
        return {
          locked: false,
          id: credId,
          name: c.name,
          type: c.type,
          reads: boundTriggers.length > 0,
          writes: false,
          automationCount: boundTriggers.length,
          importNames: (importedByCredentialId.get(credId) ?? []).map(({ name }) => name),
          connectLines: connectLinesOf({
            imported: importedByCredentialId.get(credId) ?? [],
            secretOf: installsBySecretId.get(credId) ?? [],
          }),
          onlyYou: onlyYours.has(credId),
          sharedThrough: sharedThrough.get(credId) ?? [],
        };
      });

      // Model A: `trigger.kind` is the adapter slug now. Resolving every
      // first-class kind to its canonical slug lets one membership test cover
      // BOTH a legacy kind-valued row ('CUSTOM_EMAIL') and a new slug-valued
      // row ('email') — they share a slug.
      const FIRST_CLASS_SLUGS = new Set<string>(
        [...FIRST_CLASS_KINDS].map((k) => resolveAdapterSlug(k)),
      );

      // A trigger of `kind` belongs to which built-in channel? CUSTOM_EMAIL /
      // MAILGUN both fan into the built-in inbound email door; TWILIO into the
      // WhatsApp number. Built-in kinds (INBOUND_EMAIL etc.) map to themselves.
      const KIND_TO_CHANNEL: Record<string, string> = {
        INBOUND_EMAIL: 'INBOUND_EMAIL',
        INBOUND_WHATSAPP: 'INBOUND_WHATSAPP',
        WEB: 'WEB',
        CUSTOM_EMAIL: 'INBOUND_EMAIL',
        MAILGUN: 'INBOUND_EMAIL',
        TWILIO: 'INBOUND_WHATSAPP',
        // Model A slugs. A bare email adapter defaults to the built-in inbound
        // email door — which inbox a multi-inbox team uses is an inbound-config
        // concern, not the adapter identity (see the email-channel note).
        email: 'INBOUND_EMAIL',
        web: 'WEB',
        whatsapp: 'INBOUND_WHATSAPP',
      };

      const channelCounts = new Map<string, number>();
      for (const t of triggerRows) {
        const channelKind =
          KIND_TO_CHANNEL[t.kind] ?? KIND_TO_CHANNEL[resolveAdapterSlug(t.kind)];
        if (!channelKind) continue;
        const count = channelCounts.get(channelKind) ?? 0;
        channelCounts.set(channelKind, count + 1);
      }

      const sourceChannels: ConnectionsSourceChannel[] = BUILT_IN_CHANNELS.map((c) => ({
        ...c,
        automationCount: channelCounts.get(c.kind) ?? 0,
      }));

      // Custom = trigger kinds the page doesn't otherwise represent.
      // First-class kinds (channels + credentialled integrations) are
      // already counted, so they don't double-up here.
      const custom: ConnectionsCustomRow[] = triggerRows
        .filter((t) => !FIRST_CLASS_SLUGS.has(resolveAdapterSlug(t.kind)))
        .filter((t) => isProd || !DEV_FIXTURE_NAME_RE.test(t.name))
        .map((t) => ({
          id: t.id as unknown as string,
          name: t.name,
          kind: t.kind,
          kindLabel: kindToLabel(t.kind),
          configSummary: summariseConfig(t.config),
        }));

      return { integrations, sourceChannels, custom };
    }),

    /**
     * What deleting this credential would affect — the read-only payload
     * behind the delete-confirmation dialog (see
     * `CredentialDependentsPayload` for the honest enumeration). The
     * deletion itself stays on `pipelineConfiguration.deleteCredential`,
     * which owns the per-type teardown (token revocation, cached-client
     * eviction, owned-token release, webhook deregistration).
     */
    credentialDependents: userProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }): Promise<CredentialDependentsPayload> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const credentialId = input.id as ExternalServiceCredentialsId;

        // Ownership gate: the id must be one of this team's credentials, and
        // one the caller may use. Everything below filters by credentials_id
        // alone, which is safe only once we know both.
        const owned = await getAutomationsQb(['external_service_credentials'])
          .selectFrom('external_service_credentials')
          .where('id', '=', credentialId)
          .where('team_id', '=', teamId)
          .select(['id'])
          .executeTakeFirst();
        if (owned === undefined || (await connectionUnseen(input.id))) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `No connection ${input.id}.` });
        }

        const [
          credentialRows,
          manifests,
          movementRows,
          triggerRows,
          webhookRows,
          remoteAdapterRows,
        ] = await Promise.all([
          loadCredentialRows(teamId, callerAudience()),
          teamAdapterManifests(teamId, []),
          getAutomationsQb(['movement'])
            .selectFrom('movement')
            .where('team_id', '=', teamId)
            .select(['id', 'name', 'validity_status', 'source'])
            .execute(),
          getAutomationsQb(['trigger'])
            .selectFrom('trigger')
            .where('team_id', '=', teamId)
            .where('credentials_id', '=', credentialId)
            .select(['id', 'name', 'movement_id'])
            .orderBy('name', 'asc')
            .execute(),
          getAutomationsQb(['webhook_subscription'])
            .selectFrom('webhook_subscription')
            .where('credentials_id', '=', credentialId)
            .where('deleted_at', 'is', null)
            .select(['id'])
            .execute(),
          getAutomationsQb(['remote_adapter'])
            .selectFrom('remote_adapter')
            .where('credentials_id', '=', credentialId)
            .select(['id'])
            .execute(),
        ]);

        // The credential's import names, computed over ALL team rows —
        // collision suffixes depend on the whole set, so projecting a
        // single row in isolation could disagree with what the language
        // actually resolves.
        const byImportName = credentialImportNames({
          rows: credentialRows,
          manifests,
        });
        const importNames = Object.entries(byImportName)
          .filter(([, row]) => row.id === (credentialId as unknown as string))
          .map(([name]) => name);

        // Only what the caller may read is counted or named.
        const readableMovements = await readableAmong(movementRows, { automationOf: (m) => m.id, teamIds: [teamId] });
        const readableTriggers = await readableAmong(triggerRows, { automationOf: (t) => t.movement_id, teamIds: [teamId] });
        const movements = movementsImportingCredential(
          readableMovements.map((m) => ({
            id: m.id as unknown as string,
            name: m.name,
            validityStatus: m.validity_status,
            source: m.source,
          })),
          importNames,
        );

        return {
          importNames,
          movements,
          automations: readableTriggers.map((t) => ({
            id: t.id as unknown as string,
            name: t.name,
          })),
          webhookSubscriptionCount: webhookRows.length,
          remoteAdapterCount: remoteAdapterRows.length,
        };
      }),

    /**
     * Mint a one-time deep-link handshake token for the logged-in user and
     * return the `t.me/<bot>?start=<token>` URL they open to bind their
     * Telegram account. The token carries the (user, team) identity; the
     * actual `telegram_identity` binding is written only when the user's real
     * Telegram account sends `/start <token>` (Chunk 5's webhook →
     * `bindTelegramFromStart`) — so the URL is safe to display.
     *
     * Requires `TELEGRAM_BOT_USERNAME` (the shared bot's @username) to build
     * the link; unset → a clear "bot not configured" error rather than a
     * broken URL. Dedupe lives in `mintTelegramToken` (one live unconsumed
     * token per user/team).
     *
     */
    connectTelegram: userProcedure.mutation(
      async (): Promise<{ url: string; token: string; expiresAt: Date }> => {
        const botUsername = builtInBotUsername();
        if (!botUsername) {
          throw new Error(
            'Telegram bot is not configured. Set TELEGRAM_BOT_USERNAME to enable account linking.',
          );
        }

        const ctx = currentContext();
        const { token, expiresAt } = await mintTelegramToken({
          nativeUserId: ctx.user.id,
          teamId: ctx.user.teamId,
        });

        return { url: telegramStartUrl({ botUsername, token }), token, expiresAt };
      },
    ),

    /**
     * Connect the TEAM to the optional shared built-in Telegram bot (the empty
     * `TELEGRAM` credential). Distinct from `connectTelegram`, which links a
     * single USER's identity via the deep-link handshake. Mechanics live in
     * `ensureSharedTelegramTeamCredential` (shared with the author-time
     * connect-link landing route).
     */
    connectTelegramTeam: userProcedure
      .input(z.object({ use: GranteesInput.optional() }).optional())
      .mutation(async ({ input }): Promise<TelegramTeamConnect> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const existing = await getAutomationsQb(['external_service_credentials'])
          .selectFrom('external_service_credentials')
          .where('team_id', '=', teamId)
          .where('type', '=', ExternalServiceType.TELEGRAM)
          .select('id')
          .executeTakeFirst();
        // Who may use it is asked only of a connection this creates; one given
        // for the team's existing connection would not be applied, so it is refused.
        if (existing !== undefined && input?.use !== undefined) return { ok: false, reason: 'given_for_existing' };
        if (existing === undefined && input?.use === undefined) return { ok: false, reason: 'needs_use' };
        const use = existing === undefined ? await useForNewConnection({ teamId, use: input?.use }) : undefined;
        const ensured = await ensureSharedTelegramTeamCredential({
          teamId,
          userId: ctx.user.id as UserId,
          use,
        });
        if ('needsUse' in ensured) return { ok: false, reason: 'needs_use' };
        // A team holds one shared Telegram connection: one the caller may not
        // use is not handed to them, and no second is made beside it.
        if (!ensured.created && (await connectionUnseen(ensured.id))) return { ok: false, reason: 'not_usable' };
        return { ok: true, ...ensured };
      }),
  });
};

decidesEach('connections', {
  getAll: USE_CONNECTION,
  credentialDependents: USE_CONNECTION,
  connectTelegram: { exempt: "links the caller's own Telegram account, no connection" },
  connectTelegramTeam: USE_CONNECTION,
});

export { connectionsRouter };
