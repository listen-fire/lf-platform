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
//
// Ask is static too, but production typed an ask's answer by the ask's own
// literals (an `Answer Type`, a form's `Fields`, a choice's `Options`), inside
// the connected projection this package does not carry. Its base surface types
// those answers wrongly in both directions, so ask is a gap until that
// projection is carried.

import type { Adapter, AdapterManifest } from '@listen-fire/engine/public/adapter';
import { buildCatalogSnapshot, credentialImportNames, type CatalogAdapterInput } from '@listen-fire/engine/public/catalog';
import { introspectAdapter } from '@listen-fire/engine/public/embed';
import { availableChatModels } from '@listen-fire/engine/public/models';
import { bundledPluginSpecs } from '@listen-fire/engine/public/plugins';
import {
  instanceSchemaKey,
  type CatalogSnapshot,
  type ConstructionCall,
  type CredentialSpec,
  type InstanceSchema,
  type Program,
} from '@listen-fire/movement-lang';

import { SystemAdapter } from '../modules/system/adapter';
import { SYSTEM_MANIFEST } from '../modules/system/manifest';
import { CRON_MANIFEST, createCronAdapter } from '../units/cron';
import { MANUAL_MANIFEST, createManualAdapter } from '../units/manual';
import { manifestsOf } from './manifests';
import type { CheckGap, TeamFacts } from './types';

/** The adapters whose whole surface is static, described as production's
 *  adapters described themselves. */
const DESCRIBED: readonly { manifest: AdapterManifest; adapter: Adapter }[] = [
  // Describing reads no team's records: no team, and no document read.
  { manifest: CRON_MANIFEST, adapter: createCronAdapter({ teamId: '' }) },
  {
    manifest: MANUAL_MANIFEST,
    adapter: createManualAdapter({
      teamId: '',
      readDocument: async () => {
        throw new Error('the manual unit reads no file while it is described');
      },
    }),
  },
  { manifest: SYSTEM_MANIFEST, adapter: new SystemAdapter() },
];

let described: Promise<ReadonlyMap<string, { schema: InstanceSchema; notes: string[] }>> | undefined;

/** The static surfaces' schemas, read once per process: they are the same for
 *  every team. A failed read is not kept, so the next check reads again. */
function describedSchemas(): Promise<ReadonlyMap<string, { schema: InstanceSchema; notes: string[] }>> {
  if (described === undefined) {
    const reading = Promise.all(
      DESCRIBED.map(async ({ manifest, adapter }) => [manifest.adapterType, await introspectAdapter(adapter, manifest)] as const),
    ).then((entries) => new Map(entries));
    described = reading;
    reading.catch(() => {
      if (described === reading) described = undefined;
    });
  }
  return described;
}

/** Every construction anywhere in `node`: at the top level, in a function
 *  body, a block or a branch. The walk is over the tree's shape, so a
 *  construction in a statement kind added later is found too. */
function constructionsIn(node: unknown, found: ConstructionCall[]): void {
  if (Array.isArray(node)) {
    for (const item of node) constructionsIn(item, found);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  if ('kind' in node && node.kind === 'construct' && 'construct' in node && isConstruction(node.construct)) {
    found.push(node.construct);
  }
  for (const value of Object.values(node)) constructionsIn(value, found);
}

function isConstruction(value: unknown): value is ConstructionCall {
  return typeof value === 'object' && value !== null && 'callee' in value && typeof value.callee === 'string';
}

/** What `program` connects, by adapter key: its constructions anywhere,
 *  through the names its `adapters` import binds. A construction whose callee
 *  is no adapter in `adapters` (a call to a movement reads the same) is not a
 *  connection. */
export function constructedAdapters(program: Program, adapters: ReadonlySet<string>): string[] {
  const imported = new Map<string, string>();
  for (const statement of program.statements) {
    if (statement.kind !== 'import' || statement.source.kind !== 'builtin' || statement.source.namespace !== 'adapters') continue;
    for (const name of statement.names) imported.set(name.alias ?? name.name, name.name.replace(/^@lf\//, ''));
  }
  const constructions: ConstructionCall[] = [];
  constructionsIn(program.statements, constructions);
  const constructed = new Set<string>();
  for (const { callee } of constructions) {
    const adapter = imported.get(callee) ?? callee;
    if (adapters.has(adapter)) constructed.add(adapter);
  }
  return [...constructed];
}

export interface TeamSnapshot {
  snapshot: CatalogSnapshot;
  notes: string[];
  /** The adapter keys whose instances this snapshot types. */
  typed: ReadonlySet<string>;
  /** Every adapter key the snapshot names. */
  adapters: ReadonlySet<string>;
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
    adapters: new Set(manifests.map((manifest) => manifest.adapterType)),
  };
}

/** Each adapter `programs` connect that `snapshot` does not type. */
export function gapsOf(programs: readonly Program[], snapshot: TeamSnapshot): CheckGap[] {
  const untyped = new Set(
    programs.flatMap((program) => constructedAdapters(program, snapshot.adapters)).filter((adapter) => !snapshot.typed.has(adapter)),
  );
  return [...untyped].map((adapter) => ({
    adapter,
    detail:
      `this platform reads a system a language 0.12 automation connects only through 0.12's own module for it, ` +
      `connected with the team's credentials, and it does not run 0.12's modules, so nothing this automation reads from or writes to ${adapter} was checked`,
  }));
}
