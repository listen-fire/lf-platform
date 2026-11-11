import type { Client } from 'pg';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { stateWhatIsUnstated } from '../access/state_unstated';
import { settingsAtCreation } from '../connections/module_settings';
import { readBundle, readTableFile, type BundleManifest } from './bundle';
import { quoteIdent, readColumns, readMigrationHead, splitQualified } from './catalog';
import { isProduct } from './manifest';

export type ImportOptions = { bundleDir: string; batchSize?: number };

export type ImportResult = {
  manifest: BundleManifest;
  inserted: Array<{ table: string; rows: number }>;
  shellCredentials: number;
  /** Automations and connections that arrived saying nothing of who may reach them, and were given the team's reach. */
  stated: { automations: number; connections: number };
};

const DEFAULT_BATCH = 500;

/**
 * Is this team already here?
 *
 * The answer decides between two behaviours and the choice is deliberate: a
 * second import REFUSES rather than merging or duplicating. Merging would need
 * a per-table conflict rule that nothing in the data can supply — a row whose
 * id matches but whose contents differ is either an edit made on the target or
 * a stale export, and only a person knows which. Duplicating would breach the
 * unique constraints on half these tables and silently double the rest.
 * Refusing is the only answer that cannot be wrong, and re-running after a
 * `delete-team --confirm` is the supported way to redo an import.
 */
async function findExistingRows(
  client: Client,
  manifest: BundleManifest,
): Promise<Array<{ table: string; rows: number }>> {
  const found: Array<{ table: string; rows: number }> = [];
  for (const entry of manifest.tables) {
    const { schema, table } = splitQualified(entry.table);
    // Reference rows are SUPPOSED to be there already — their presence says
    // nothing about whether this team has been imported.
    if (entry.referenceData || !entry.columns.includes('team_id')) continue;
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(table)} WHERE team_id = $1::uuid`,
      [manifest.teamId],
    );
    const count = Number(rows[0].count);
    if (count > 0) found.push({ table: entry.table, rows: count });
  }
  return found;
}

export async function importTeam(client: Client, options: ImportOptions): Promise<ImportResult> {
  const manifest = await readBundle(options.bundleDir);
  const batchSize = options.batchSize ?? DEFAULT_BATCH;

  const products = manifest.products.filter(isProduct);
  if (products.length !== manifest.products.length) {
    throw new Error(`Bundle names products this tool does not know: ${manifest.products.join(', ')}`);
  }

  // The schema the bundle was cut from must be the schema it lands in. Row
  // shapes are checked separately below, but the head is the cheap check that
  // catches a bundle from a different release before any of it is written.
  const head = await readMigrationHead(client);
  if (head !== manifest.migrationHead) {
    throw new Error(
      `Migration mismatch: the bundle was exported at ${manifest.migrationHead}, this database is at ${head}. ` +
        `Bring the target to the same migration and re-run.`,
    );
  }

  const columnsBySchema = await readColumns(client, products);
  for (const entry of manifest.tables) {
    const target = (columnsBySchema.get(entry.table) ?? []).map((c) => c.name);
    if (target.length === 0) throw new Error(`${entry.table} does not exist on this database`);
    const missing = entry.columns.filter((c) => !target.includes(c));
    if (missing.length > 0) {
      throw new Error(`${entry.table} on this database has no column(s): ${missing.join(', ')}`);
    }
  }

  const existing = await findExistingRows(client, manifest);
  if (existing.length > 0) {
    const detail = existing.map((e) => `${e.table} (${e.rows})`).join(', ');
    throw new Error(
      `Team ${manifest.teamId} already has rows on this database: ${detail}. ` +
        `Importing again would duplicate or half-merge them, and nothing in the data says which. ` +
        `Run delete-team --confirm first if you mean to replace it.`,
    );
  }

  const typesByTable = new Map(
    manifest.tables.map((e) => [
      e.table,
      new Map((columnsBySchema.get(e.table) ?? []).map((c) => [c.name, c.type])),
    ]),
  );

  const inserted: Array<{ table: string; rows: number }> = [];
  let shellCredentials = 0;
  let stated = { automations: 0, connections: 0 };

  await client.query('BEGIN');
  try {
    // The same mechanism `pg_restore --disable-triggers` uses, and for the same
    // three reasons: ids are preserved so foreign keys need no re-checking (the
    // slice came out coherent); the audit triggers would otherwise write an
    // enormous trail attributing a tenant's whole history to the person running
    // the import; and the outbox triggers would re-emit every carried row to
    // the target's subscribers as if it had just happened.
    await client.query('SET LOCAL session_replication_role = replica');

    for (const entry of manifest.tables) {
      const rows = await readTableFile(options.bundleDir, entry);
      if (rows.length === 0) {
        inserted.push({ table: entry.table, rows: 0 });
        continue;
      }
      const { schema, table } = splitQualified(entry.table);
      const types = typesByTable.get(entry.table);
      if (!types) throw new Error(`No column types read for ${entry.table}`);

      const columnList = entry.columns.map(quoteIdent).join(', ');
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        const values: (string | null)[] = [];
        const tuples = batch.map((row, r) => {
          const placeholders = entry.columns.map((col, c) => {
            values.push(row[c] ?? null);
            // Cast the text back to the column's declared type — the exact
            // inverse of the export's `::text`, which is what lets bytea,
            // jsonb, arrays and enums cross unchanged.
            return `$${r * entry.columns.length + c + 1}::${types.get(col)}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        // Shared reference data may already be present — a target that has
        // been through an import-delete-import cycle keeps its own currency
        // assets and FX rates, because a delete correctly declines to remove
        // rows no tenant owns. Everything else cannot conflict: the team's
        // absence was established before a single row was written.
        const onConflict = entry.referenceData ? ' ON CONFLICT DO NOTHING' : '';
        await client.query(
          `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} (${columnList}) VALUES ${tuples.join(', ')}${onConflict}`,
          values,
        );
      }
      inserted.push({ table: entry.table, rows: rows.length });
    }

    // Credentials arrive as shells (D30(b)) — the row names the connection so
    // the movements that reference it still resolve, and this stamps the state
    // the connect surface renders. Stamped HERE rather than at export time so
    // the bundle stays byte-identical across runs, and because the honest
    // reading of the timestamp is "reconnection has been required since this
    // landed on this deployment".
    if (products.includes('automations')) {
      const stamped = await client.query(
        `UPDATE automations.external_service_credentials
            SET reconnect_required_at = CURRENT_TIMESTAMP
          WHERE team_id = $1::uuid AND credentials IS NULL AND reconnect_required_at IS NULL`,
        [manifest.teamId],
      );
      shellCredentials = stamped.rowCount ?? 0;
      // A bundle from before a module declared a setting carries none for it;
      // the stored value, when there is one, stays (jsonb || lets the right win).
      for (const type of Object.values(ExternalServiceType)) {
        const declared = settingsAtCreation(type);
        if (Object.keys(declared).length === 0) continue;
        await client.query(
          `UPDATE automations.external_service_credentials
              SET module_settings = $3::jsonb || module_settings
            WHERE team_id = $1::uuid AND type = $2::automations."ExternalServiceType"`,
          [manifest.teamId, type, JSON.stringify(declared)],
        );
      }
      const statedNow = await stateWhatIsUnstated(client, manifest.teamId);
      stated = { automations: statedNow.automations.length, connections: statedNow.connections.length };
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  return { manifest, inserted, shellCredentials, stated };
}
