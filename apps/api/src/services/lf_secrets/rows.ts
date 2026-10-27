// How a credential row reads on lf's secrets wire, and the row an lf entry
// becomes. A row lf sees is one a module the platform runs would read: a
// remote module's credential (its `app_id` is the module) or a built-in
// type's (the module line whose manifest names that type). The payload reads
// as fields the way that line stores it, so a row lf writes is the row the
// platform's own connect pages write, and the other way round.

import { sql } from 'kysely';
import type { SecretsBindingShape } from 'engine-contracts/slots';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb } from '../../lib/kysely';
import { BUILTIN_MODULES, storedDeclaration, type BuiltinModuleLine } from '../translation_graph/adapters/builtin_modules';
import { GMAIL_APP_ID, defaultAppIdForType, gmailCredentialShape } from '../credentials/app_id';
import { flatPayloadShape, type PayloadShape } from '../credentials/secrets_postgres';
import { gmailOAuthPayloadShape } from '../../adapters/gmail/module_credential';

type AdapterModuleLine = Extract<BuiltinModuleLine, { kind: 'adapter'; line: 'module' }>;

/** The columns that say what a row is bound to. */
export interface StoredBinding {
  type: ExternalServiceType;
  app_id: string | null;
  declared_credential: string | null;
  wire_binding: string | null;
}

/** A row as lf reads it. */
export interface WireReading {
  external: string;
  binding: SecretsBindingShape;
  shape: PayloadShape;
}

/** The row an lf entry becomes. */
export interface WireTarget {
  type: ExternalServiceType;
  appId: string | null;
  declaredCredential: string | null;
  wireBinding: 'install' | 'legacy' | null;
  shape: PayloadShape;
}

/** Keys into this platform itself, which it provisions for its own modules
 *  (Valuations, the knowledge graph): no provider account lf could use. */
const PLATFORM_SUPPLIED: ReadonlySet<ExternalServiceType> = new Set([
  ExternalServiceType.NATIVE_VALUATIONS,
  ExternalServiceType.NATIVE_KNOWLEDGE,
]);

/** The module lines that read a credential type, in declaration order:
 *  GOOGLE has two (Sheets and Drive), and reads as the first. */
function lineForType(type: ExternalServiceType): { external: string; line: AdapterModuleLine } | undefined {
  if (PLATFORM_SUPPLIED.has(type)) return undefined;
  for (const [external, line] of Object.entries(BUILTIN_MODULES)) {
    if (line.kind === 'adapter' && line.line === 'module' && line.manifest.requiredCredentialType === type) return { external, line };
  }
  return undefined;
}

/** The credential-carrying module line lf names as `external`. */
function lineNamed(external: string): { type: ExternalServiceType; line: AdapterModuleLine } | undefined {
  const line = Object.hasOwn(BUILTIN_MODULES, external) ? BUILTIN_MODULES[external] : undefined;
  if (line === undefined || line.kind !== 'adapter' || line.line !== 'module') return undefined;
  const type = Object.values(ExternalServiceType).find((candidate) => candidate === line.manifest.requiredCredentialType);
  if (type === undefined || PLATFORM_SUPPLIED.has(type)) return undefined;
  return { type, line };
}

function shapeOf(type: ExternalServiceType, line: AdapterModuleLine | undefined): PayloadShape {
  // Gmail's line reads its credential itself (two stored shapes); lf is
  // served only the signed-in one.
  if (type === ExternalServiceType.GOOGLE_GMAIL) return gmailOAuthPayloadShape;
  return line?.storedAs ?? flatPayloadShape;
}

function storedBinding(value: string | null): 'install' | 'legacy' | undefined {
  return value === 'install' || value === 'legacy' ? value : undefined;
}

/** How `row` reads on the wire, or null when lf is not served it. */
export function wireReading(row: StoredBinding): WireReading | null {
  const named = storedBinding(row.wire_binding);
  if (row.type === ExternalServiceType.REMOTE) {
    if (row.app_id === null) return null;
    const binding = named ?? (row.declared_credential !== null ? { credential: row.declared_credential } : 'install');
    return { external: row.app_id, binding, shape: flatPayloadShape };
  }
  if (row.type === ExternalServiceType.GOOGLE_GMAIL && gmailCredentialShape(row.app_id) !== 'oauth') return null;
  const found = lineForType(row.type);
  if (found === undefined) return null;
  const declared = row.declared_credential ?? storedDeclaration(found.line.load(), found.line.declaredCredential)?.name;
  const binding = named ?? (declared !== undefined ? { credential: declared } : 'legacy');
  return { external: found.external, binding, shape: shapeOf(row.type, found.line) };
}

/** The row lf's entry `{ external, binding }` becomes: a built-in's type when
 *  lf names a module line, else a remote module's credential. */
export function wireTarget(entry: { external: string; binding: SecretsBindingShape }): WireTarget {
  const wireBinding = typeof entry.binding === 'string' ? entry.binding : null;
  const builtin = lineNamed(entry.external);
  if (builtin !== undefined) {
    return {
      type: builtin.type,
      appId: builtin.type === ExternalServiceType.GOOGLE_GMAIL ? GMAIL_APP_ID.oauthMailbox : (defaultAppIdForType(builtin.type) ?? null),
      // A built-in's credential is the one its module declares, not a column.
      declaredCredential: null,
      wireBinding,
      shape: shapeOf(builtin.type, builtin.line),
    };
  }
  return {
    type: ExternalServiceType.REMOTE,
    appId: entry.external,
    declaredCredential: typeof entry.binding === 'string' ? null : entry.binding.credential,
    wireBinding,
    shape: flatPayloadShape,
  };
}

/** The credentials of a team that `secrets.list` answers lf: every connected
 *  (non-shell) row lf is served, by name, with how it reads and a version that
 *  hashes the ciphertext in SQL, so nothing is decrypted. The one rule for
 *  what lf can import from `credentials`. */
export async function servedCredentials(
  teamId: string,
): Promise<Array<{ ref: string; external: string; binding: SecretsBindingShape; version: string }>> {
  const rows = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .where('credentials', 'is not', null)
    .select(['name', 'type', 'app_id', 'declared_credential', 'wire_binding', sql<string>`encode(sha256(credentials), 'hex')`.as('version')])
    .orderBy('name')
    .execute();
  return rows.flatMap((row) => {
    const reading = wireReading(row);
    return reading === null ? [] : [{ ref: row.name, external: reading.external, binding: reading.binding, version: row.version }];
  });
}
