import { Command, command, metadata, option, Options } from 'clime';

import { connect } from '../../../services/team_migration/bundle';
import { importTeam } from '../../../services/team_migration/import';
import { getEnvVar } from '../../../lib/utils/environment';

class ImportTeamOptions extends Options {
  @option({ flag: 'i', description: 'Bundle directory written by export-team', required: true })
  in!: string;

  @option({ description: 'Database to write to; defaults to DATABASE_URL' })
  databaseUrl?: string;
}

/**
 * A bundle, into this deployment.
 *
 * Team-scoped by construction: every row it writes carries the bundle's team,
 * and the only rows it reads are that team's — it has no expression that could
 * reach another tenant. Ids are preserved, so the movements, triggers and
 * graph edges that reference each other still do. Nothing is re-minted:
 * credentials arrive as shells and the connect surface asks for a reconnect.
 */
@command({ description: "Import a team bundle into this deployment" })
export default class extends Command {
  @metadata
  async execute(options: ImportTeamOptions): Promise<void> {
    const client = await connect(options.databaseUrl ?? getEnvVar('DATABASE_URL'));
    try {
      const { manifest, inserted, shellCredentials, stated } = await importTeam(client, {
        bundleDir: options.in,
      });
      const total = inserted.reduce((sum, t) => sum + t.rows, 0);
      console.warn(
        `Imported team ${manifest.teamId}${manifest.teamName ? ` (${manifest.teamName})` : ''} ` +
          `— ${total} rows across ${inserted.length} tables`,
      );
      for (const t of inserted.filter((t) => t.rows > 0)) console.warn(`  ${t.table}: ${t.rows}`);
      if (shellCredentials > 0) {
        console.warn(
          `${shellCredentials} connection(s) arrived without their secret and must be reconnected before any movement using them will run.`,
        );
      }
      if (stated.automations + stated.connections > 0) {
        console.warn(
          `${stated.automations} automation(s) and ${stated.connections} connection(s) arrived saying nothing of who may reach them, and were given the whole team's.`,
        );
      }
    } finally {
      await client.end();
    }
  }
}
