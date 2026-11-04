// The catalog snapshot a 0.12 program is checked against, built as production
// built its editor's snapshot at 0.12.13 (`movement/catalog.ts` on main,
// `skeletonAdapters` and `movementCatalogSnapshotForTeam`): every manifest's
// adapter, the team's credentials, the bundled plugins, the import namespace
// and the models, handed to 0.12's own `buildCatalogSnapshot`.
//
// Production then filled the schemas of the instances a program names by
// asking each module, connected with the team's credentials. This package
// carries 0.12's modules but not their running halves, so it reads only what
// needs no connection: the units and the platform's static modules, described
// here exactly as their adapters described themselves. Every other instance a
// program names is a gap, said out loud: its reads and writes were not checked,
// so the program is unverified, never clean.

import type { Adapter, AdapterManifest } from '@listen-fire/engine/public/adapter';
import { buildCatalogSnapshot, credentialImportNames, type CatalogAdapterInput } from '@listen-fire/engine/public/catalog';
import { introspectAdapter } from '@listen-fire/engine/public/embed';
import { availableChatModels } from '@listen-fire/engine/public/models';
import { bundledPluginSpecs } from '@listen-fire/engine/public/plugins';
import { instanceSchemaKey, type CatalogSnapshot, type CredentialSpec, type InstanceSchema, type Program } from '@listen-fire/movement-lang';

import { AskSurface } from '../modules/ask/surface';
import { ASK_MANIFEST } from '../modules/ask/manifest';
import { SystemAdapter } from '../modules/system/surface';
import { SYSTEM_MANIFEST } from '../modules/system/manifest';
import { CRON_MANIFEST, CronSurface } from '../units/cron';
import { MANUAL_MANIFEST, ManualSurface } from '../units/manual';
import { manifestsOf } from './manifests';
import type { CheckGap, TeamFacts } from './types';

/** The adapters whose whole surface is static, described as production's
 *  adapters described themselves. */
const DESCRIBED: readonly { manifest: AdapterManifest; adapter: Adapter }[] = [
  { manifest: CRON_MANIFEST, adapter: new CronSurface() },
  { manifest: MANUAL_MANIFEST, adapter: new ManualSurface() },
  { manifest: SYSTEM_MANIFEST, adapter: new SystemAdapter() },
  { manifest: ASK_MANIFEST, adapter: new AskSurface() },
];

let described: Promise<ReadonlyMap<string, { schema: InstanceSchema; notes: string[] }>> | undefined;

/** The static surfaces' schemas, read once per process: they are the same for
 *  every team. */
function describedSchemas(): Promise<ReadonlyMap<string, { schema: InstanceSchema; notes: string[] }>> {
  described ??= Promise.all(
    DESCRIBED.map(async ({ manifest, adapter }) => [manifest.adapterType, await introspectAdapter(adapter, manifest)] as const),
  ).then((entries) => new Map(entries));
  return described;
}

/** What `program` connects, by adapter key: its constructions, through the
 *  names its `adapters` import binds. */
export function constructedAdapters(program: Program): string[] {
  const imported = new Map<string, string>();
  for (const statement of program.statements) {
    if (statement.kind !== 'import' || statement.source.kind !== 'builtin' || statement.source.namespace !== 'adapters') continue;
    for (const name of statement.names) imported.set(name.alias ?? name.name, name.name.replace(/^@lf\//, ''));
  }
  const constructed = new Set<string>();
  for (const statement of program.statements) {
    if (statement.kind === 'assign' && statement.value.kind === 'construct') {
      const callee = statement.value.construct.callee;
      constructed.add(imported.get(callee) ?? callee);
    }
  }
  return [...constructed];
}

export interface TeamSnapshot {
  snapshot: CatalogSnapshot;
  notes: string[];
  /** The adapter keys whose instances this snapshot types. */
  typed: ReadonlySet<string>;
}

/** The team's 0.12 snapshot, with `files` as the import namespace. */
export async function teamSnapshot(team: TeamFacts, files: Record<string, { source: string }>): Promise<TeamSnapshot> {
  const notes: string[] = [];
  const manifests = manifestsOf(team);
  const schemas = await describedSchemas();
  const adapters: CatalogAdapterInput[] = manifests.map((manifest) => {
    const declared = manifest.requiredCredentialType;
    const entry: CatalogAdapterInput = {
      manifest,
      ...(declared !== undefined ? { connect: team.connectOf(declared) } : {}),
    };
    const own = schemas.get(manifest.adapterType);
    if (own !== undefined) {
      notes.push(...own.notes);
      return { ...entry, schemas: { [instanceSchemaKey({ positionKey: '' })]: own.schema } };
    }
    if (declared !== undefined && !team.credentials.some((row) => row.type === declared)) {
      const note = `${manifest.adapterType}: no ${declared} credential on this team — instance untyped`;
      notes.push(note);
      return { ...entry, schemaNotes: { '': [note] } };
    }
    return entry;
  });
  const credentials: Record<string, CredentialSpec> = {};
  for (const [name, row] of Object.entries(credentialImportNames({ rows: [...team.credentials], manifests }))) {
    credentials[name] = { adapters: row.adapters, ...(row.credential !== undefined ? { credential: row.credential } : {}) };
  }
  return {
    snapshot: buildCatalogSnapshot({
      adapters,
      credentials,
      plugins: bundledPluginSpecs(),
      files,
      models: availableChatModels(),
    }),
    notes,
    typed: new Set(schemas.keys()),
  };
}

/** Each adapter `programs` connect that `snapshot` does not type. */
export function gapsOf(programs: readonly Program[], snapshot: TeamSnapshot): CheckGap[] {
  const untyped = new Set(programs.flatMap(constructedAdapters).filter((adapter) => !snapshot.typed.has(adapter)));
  return [...untyped].map((adapter) => ({
    adapter,
    detail:
      `this platform reads a system a language 0.12 automation connects only through 0.12's own module for it, ` +
      `connected with the team's credentials, and it does not run 0.12's modules, so nothing this automation reads from or writes to ${adapter} was checked`,
  }));
}
