/**
 * What a tenant IS, table by table.
 *
 * The database already knows two of the three things a per-team migration
 * needs: which tables exist, and which table must be written before which
 * (the foreign-key graph). It is read for both — see `catalog.ts` — so nothing
 * here restates a fact Postgres can be asked for. Ordering in particular is
 * DERIVED, never declared, which is why adding a table to a unit schema cannot
 * silently leave this file's ordering stale.
 *
 * What Postgres cannot know is the third thing: which rows belong to a team.
 * `team_id` answers it for most tables and nothing answers it for some, so that
 * — and only that — is what this file declares. Every table in the five unit
 * schemas appears below exactly once; `catalog.ts` refuses to run if one is
 * missing, so a new table cannot join a schema without someone deciding what
 * it means to a tenant.
 *
 */

export const PRODUCTS = ['core', 'valuations', 'automations', 'knowledge', 'asks'] as const;
export type Product = (typeof PRODUCTS)[number];

export function isProduct(value: string): value is Product {
  return (PRODUCTS as readonly string[]).includes(value);
}

/**
 * How a row is known to belong to a team.
 *
 * `via` composes: a parent's own predicate is substituted into the child's
 * subquery, so a multi-hop chain (a phone → the user it belongs to → the
 * team's membership) is two ordinary declarations rather than one
 * hand-written join.
 */
export type Tenancy =
  /** The tenant root itself — matched on `id`, not on `team_id`. */
  | { kind: 'team_root' }
  /**
   * `team_id = <team>`. `alsoGlobalRows` additionally takes the rows whose
   * `team_id` is NULL: some tables hold a team's rows and the deployment's
   * shared reference rows in one place, and a slice that omitted the shared
   * ones would import as dangling references.
   */
  | { kind: 'team_column'; alsoGlobalRows?: true }
  /** Reachable only through another table's slice. */
  | {
      kind: 'via';
      /** Column on THIS table. */
      column: string;
      /** Schema-qualified parent table. */
      parent: string;
      /** Column on the parent that `column` matches. Defaults to `id`. */
      parentColumn?: string;
    }
  /** Deployment-wide reference data with no tenant at all. */
  | { kind: 'global' };

export type TableSpec = {
  /** Bare table name; the product's schema qualifies it. */
  table: string;
  tenancy: Tenancy;
  /**
   * Set when the traversal leaves this product's schema. The export declines
   * the table — loudly, by name — when that product is not in the set, rather
   * than silently emitting an empty slice.
   */
  requiresProduct?: Product;
  /**
   * The table is not EXPORTED, and this says why. A team delete still visits
   * it: not carrying a row forward and not deleting it are different rulings.
   */
  exportExcludedBecause?: string;
  /**
   * The table is neither exported NOR deleted, and this says why. Reserved for
   * rows that are not tenant data at all.
   */
  outOfScopeBecause?: string;
  /**
   * Column → literal SQL substituted into the export's SELECT in place of the
   * stored value. This is how a shell row is written: the export decides what
   * a column means on the far side, in SQL, at the one place that reads it.
   */
  rewrite?: Record<string, string>;
  /**
   * Run and delivery history. Bulky, the most PII-dense part of the set, and
   * doc 10 §2d recommends leaving it behind — so `--without-history` skips it
   * and the manifest records which choice was made.
   */
  history?: true;
  /**
   * These rows belong to the DEPLOYMENT, not to the team, so the target may
   * already have them — and if it does, the target's copy wins. The bundle
   * carries a copy only so that a fresh target is not empty of the reference
   * data the tenant's own rows point at.
   *
   * It cannot be derived from `tenancy` alone: `currency_asset` is reached by
   * traversal, not by a global predicate, yet its rows are as shared as the
   * assets they name.
   */
  referenceData?: true;
  /**
   * An extra predicate applied when DELETING but not when exporting, with the
   * reason it differs. It composes through `via` exactly as the tenancy does,
   * so a restriction stated once is inherited by everything downstream of it.
   *
   * `{alias}` is substituted with the table's alias.
   */
  deleteOnlyWhere?: { sql: string; because: string };
};

/**
 * `audit_log` is the same ruling in all five schemas, so it is written once.
 * It is a record of writes that happened in the SOURCE database; replaying it
 * into a target would attribute to that deployment a history it never had. It
 * is still deleted with the team, because the rows are the team's.
 */
const AUDIT_LOG: TableSpec = {
  table: 'audit_log',
  tenancy: { kind: 'team_column' },
  exportExcludedBecause:
    'the audit trail records writes that happened in the source database; importing it would attribute to the target a history it never had',
};

/**
 * A heartbeat is a fact about the process that wrote it, not about a team, so
 * it is neither carried nor purged.
 */
const WORKER_HEARTBEAT: TableSpec = {
  table: 'worker_heartbeat',
  tenancy: { kind: 'global' },
  outOfScopeBecause: 'worker liveness is a fact about a process, not about a tenant',
};

export const MANIFEST: Record<Product, TableSpec[]> = {
  core: [
    AUDIT_LOG,
    { table: 'team', tenancy: { kind: 'team_root' } },
    { table: 'team_membership', tenancy: { kind: 'team_column' } },
    { table: 'api_key', tenancy: { kind: 'team_column' } },
    { table: 'team_invite', tenancy: { kind: 'team_column' } },
    {
      // Users span teams, so a per-team export carries the people this team's
      // memberships name — no more. `default_team_id` is rewritten because the
      // user's home in the TARGET deployment is the team being imported; left
      // alone it would point at a team that does not exist there.
      table: 'user',
      tenancy: { kind: 'via', column: 'id', parent: 'core.team_membership', parentColumn: 'user_id' },
      rewrite: { default_team_id: ':team' },
      // Export carries every member; DELETE keeps anyone who is also somebody
      // else's colleague. A person is not the team's property, and deleting a
      // shared account to complete one offboarding would break the other
      // team's logins. Everything that hangs off a user — their emails, their
      // phones — inherits this through the traversal.
      deleteOnlyWhere: {
        sql: 'NOT EXISTS (SELECT 1 FROM core.team_membership shared WHERE shared.user_id = {alias}.id AND shared.team_id <> $1::uuid)',
        because: 'a user who also belongs to another team survives this team’s deletion',
      },
    },
    {
      table: 'user_email',
      tenancy: { kind: 'via', column: 'user_id', parent: 'core.user' },
    },
    {
      table: 'magic_link_token',
      tenancy: { kind: 'via', column: 'user_id', parent: 'core.user' },
      exportExcludedBecause:
        'a live login capability minted for the source origin; carrying it would hand the target a credential nobody issued there',
    },
    {
      table: 'pending_signup',
      tenancy: { kind: 'global' },
      outOfScopeBecause: 'a signup that has not yet chosen a team is not a tenant row',
    },
  ],

  valuations: [
    AUDIT_LOG,
    WORKER_HEARTBEAT,
    { table: 'legal_entity', tenancy: { kind: 'team_column' } },
    { table: 'event', tenancy: { kind: 'team_column' } },
    { table: 'investment', tenancy: { kind: 'team_column' } },
    {
      table: 'investment_attribution',
      tenancy: { kind: 'via', column: 'investment_id', parent: 'valuations.investment' },
    },
    { table: 'transaction', tenancy: { kind: 'team_column' } },
    {
      // A team's own assets AND the deployment-wide currency assets, which
      // carry a NULL team_id and which this team's prices and transactions
      // reference. A fresh target has none of them — they are minted by the FX
      // CLI, not by a migration — so a slice that took only the team's rows
      // would import prices pointing at assets that are not there.
      table: 'asset',
      tenancy: { kind: 'team_column', alsoGlobalRows: true },
      referenceData: true,
    },
    {
      table: 'currency_asset',
      tenancy: { kind: 'via', column: 'asset_id', parent: 'valuations.asset' },
      referenceData: true,
    },
    {
      // Deployment-wide FX reference data. Valuations arithmetic in any
      // currency but the reporting one is wrong without it.
      table: 'exchange_rate',
      tenancy: { kind: 'global' },
      referenceData: true,
    },
    { table: 'price', tenancy: { kind: 'team_column' } },
    { table: 'asset_transfer', tenancy: { kind: 'team_column' } },
    { table: 'funding_changelog', tenancy: { kind: 'team_column' } },
    {
      table: 'funding_changelog_fund',
      tenancy: { kind: 'via', column: 'changelog_id', parent: 'valuations.funding_changelog' },
    },
    { table: 'note', tenancy: { kind: 'team_column' } },
    { table: 'team_settings', tenancy: { kind: 'team_column' } },
    { table: 'webhook_subscription', tenancy: { kind: 'team_column' } },
    {
      table: 'outbound_delivery',
      tenancy: { kind: 'team_column' },
      history: true,
    },
    {
      table: 'valuations_change_outbox',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'undelivered change events addressed to the source deployment’s subscribers; importing them would re-deliver history to the target’s',
    },
  ],

  automations: [
    AUDIT_LOG,
    { table: 'movement', tenancy: { kind: 'team_column' } },
    { table: 'movement_version', tenancy: { kind: 'team_column' } },
    { table: 'movement_issue', tenancy: { kind: 'team_column' } },
    { table: 'movement_story_token', tenancy: { kind: 'team_column' } },
    { table: 'trigger', tenancy: { kind: 'team_column' } },
    { table: 'trigger_event', tenancy: { kind: 'team_column' }, history: true },
    { table: 'trigger_run', tenancy: { kind: 'team_column' }, history: true },
    {
      table: 'parked_run',
      tenancy: { kind: 'via', column: 'run_id', parent: 'automations.trigger_run' },
    },
    {
      table: 'join_pending',
      tenancy: { kind: 'via', column: 'run_id', parent: 'automations.trigger_run' },
    },
    {
      table: 'join_branch_export',
      tenancy: { kind: 'via', column: 'run_id', parent: 'automations.trigger_run' },
    },
    { table: 'adapter_await', tenancy: { kind: 'team_column' } },
    // The library texts parked runs name by hash: carried with the parks that read them.
    { table: 'park_library_source', tenancy: { kind: 'team_column' } },
    {
      table: 'work',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'queued work leased and due on the source’s workers; importing it would run the source’s pending wakes and firings on the target, whose own sweeps re-arm what its runs need',
    },
    {
      table: 'system_event',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'the platform’s own events about the source deployment (a release applied there, a run paused there); the target emits its own',
    },
    {
      table: 'deploy_check',
      tenancy: { kind: 'global' },
      outOfScopeBecause: 'which releases this deployment’s deploy check has swept: a fact about the deployment, not a tenant',
    },
    {
      table: 'cache_entry',
      tenancy: { kind: 'global' },
      outOfScopeBecause: 'the deployment’s expiring cache and loop-guard buckets, kept when no Redis is configured; machine churn, not tenant data',
    },
    // What the lf store module keeps beside lf's runs (services/lf_store).
    { table: 'inbound_checkpoint', tenancy: { kind: 'team_column' } },
    { table: 'event_receipt', tenancy: { kind: 'team_column' }, history: true },
    { table: 'delivery', tenancy: { kind: 'team_column' }, history: true },
    {
      table: 'module_processes',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'the pids and machines of module processes lf hosts started for the source; they name nothing on the target',
    },
    { table: 'callback', tenancy: { kind: 'team_column' } },
    { table: 'record_binding', tenancy: { kind: 'team_column' } },
    {
      table: 'lf_secrets_lease',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'a runtime row of seconds’ life, keyed by team and ref, naming rows the source’s tenant held; it is deleted with the team and is not carried',
    },
    {
      // SHELL ROWS. The id survives because `trigger.credentials_id` and
      // `webhook_subscription.credentials_id` point at it; the ciphertext does
      // not, because it is AAD-bound to a master key this deployment does not
      // hand out — and because a tier-3 credential authenticates against the
      // EXPORTER's registered third-party app, so it is worthless on the
      // importer's own app however it were carried (D30(b), ST-4).
      table: 'external_service_credentials',
      tenancy: { kind: 'team_column' },
      rewrite: { credentials: 'NULL' },
    },
    {
      table: 'google_granted_item',
      tenancy: {
        kind: 'via',
        column: 'credentials_id',
        parent: 'automations.external_service_credentials',
      },
    },
    { table: 'remote_adapter', tenancy: { kind: 'team_column' } },
    { table: 'webhook_subscription', tenancy: { kind: 'team_column' } },
    { table: 'telegram_identity', tenancy: { kind: 'team_column' } },
    { table: 'telegram_token', tenancy: { kind: 'team_column' } },
    { table: 'inbound_email_route', tenancy: { kind: 'team_column' } },
    { table: 'team_settings', tenancy: { kind: 'team_column' } },
    { table: 'outbound_email', tenancy: { kind: 'team_column' }, history: true },
    {
      // The phone family's tenancy leaves this schema: `phone_number.user_id`
      // is an opaque user id (no FK, D3) and the table carries no team at all,
      // so the only thing that says which team a phone belongs to is core's
      // membership table. Declared honestly rather than approximated — see the
      // finding in 9_execution.md's 6.4 section.
      table: 'phone_number',
      tenancy: { kind: 'via', column: 'user_id', parent: 'core.user' },
      requiresProduct: 'core',
    },
    {
      table: 'phone_verification',
      tenancy: { kind: 'via', column: 'user_id', parent: 'core.user' },
      requiresProduct: 'core',
      exportExcludedBecause:
        'in-flight verification codes, expiring in minutes; carrying them across a cutover carries nothing',
    },
    // `whatsapp_conversations`/`whatsapp_messages` DROPPED at Phase 6 close
    // (D57) — writerless since the legacy dealflow era; see decisions.md and the
    // migration's inline grep. Their manifest entries (added D55(a) to give
    // them team-column tenancy) go with the tables.
    {
      table: 'connect_token',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'single-use reconnect links addressed to the source origin; the target mints its own',
    },
    {
      table: 'team_llm_key',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'one pasted model key per team, re-pasted in ninety seconds; a shell row would say only what the connect surface already shows',
    },
    {
      table: 'platform_owned_token',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'a handle on a token held by the source operator’s own third-party app registration; it names nothing on the target (ST-4, doc 10 §2e)',
    },
    {
      // It has a tenant now (D55(a)) — the 6.4 finding was fixed rather than
      // worked around, so a team's exposures can be counted and PURGED with it.
      // Best-effort rather than total: the column is nullable because the
      // movement engine establishes no ambient identity, so a file exposed by a
      // scheduler-dispatched run has no team to name (see schema.sql). Those
      // rows stay unreachable by a tenant predicate, exactly as every row was
      // before — a smaller version of the same finding, and one bounded by the
      // hour each row lives.
      // Still not carried: the row's whole value is a URL absolute at the
      // source origin, pointing at an object in the source's own bucket, and
      // expiring within the hour (ST-9). Exporting it would import a link that
      // is dead on arrival — which is a different and worse thing than a link
      // the target knows it does not have.
      table: 'exposed_file',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'a one-hour capability URL absolute at the source origin, over an object in the source’s own bucket; it is dead the moment it arrives',
    },
  ],

  knowledge: [
    AUDIT_LOG,
    WORKER_HEARTBEAT,
    // Every real knowledge table carries team_id directly — including the leaf
    // tables — so the whole schema is one declaration repeated.
    { table: 'node_type', tenancy: { kind: 'team_column' } },
    { table: 'edge_type', tenancy: { kind: 'team_column' } },
    { table: 'property_type', tenancy: { kind: 'team_column' } },
    { table: 'node', tenancy: { kind: 'team_column' } },
    { table: 'edge', tenancy: { kind: 'team_column' } },
    { table: 'property', tenancy: { kind: 'team_column' } },
    { table: 'property_arbitration', tenancy: { kind: 'team_column' } },
    { table: 'linked_object', tenancy: { kind: 'team_column' } },
    { table: 'evidence', tenancy: { kind: 'team_column' } },
    { table: 'raw_text', tenancy: { kind: 'team_column' } },
    { table: 'raw_text_part', tenancy: { kind: 'team_column' } },
    { table: 'document', tenancy: { kind: 'team_column' } },
    { table: 'resource', tenancy: { kind: 'team_column' } },
    { table: 'node_resource', tenancy: { kind: 'team_column' } },
    { table: 'extraction_fact', tenancy: { kind: 'team_column' } },
    { table: 'recipe', tenancy: { kind: 'team_column' } },
    { table: 'saved_filter', tenancy: { kind: 'team_column' } },
    { table: 'team_agent_settings', tenancy: { kind: 'team_column' } },
    { table: 'webhook_endpoint', tenancy: { kind: 'team_column' } },
    { table: 'change', tenancy: { kind: 'team_column' }, history: true },
    {
      table: 'mutation_outbox',
      tenancy: { kind: 'team_column' },
      exportExcludedBecause:
        'undelivered graph-mutation events addressed to the source deployment’s subscribers; importing them would fire the target’s listeners for writes it never saw',
    },
  ],

  asks: [
    { table: 'ask', tenancy: { kind: 'team_column' } },
    {
      table: 'ask_webhook_delivery',
      tenancy: { kind: 'via', column: 'ask_id', parent: 'asks.ask' },
      history: true,
    },
    WORKER_HEARTBEAT,
  ],
};

/** Schema-qualified name of a spec within its product. */
export function qualified(product: Product, spec: TableSpec): string {
  return `${product}.${spec.table}`;
}
