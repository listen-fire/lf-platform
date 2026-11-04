// The catalog snapshot a 0.12 program is checked and run against, built as
// production built its snapshot at 0.12.13 (`movement/catalog.ts` on main,
// `skeletonAdapters` and `movementCatalogSnapshotForTeam`): every manifest's
// adapter, the team's credentials, the bundled plugins, the import namespace
// and the models, handed to 0.12's own `buildCatalogSnapshot`.
//
// The units and the platform's static modules are described as their adapters
// described themselves. A connected system a program constructs is read from
// 0.12's own module for it, connected with the team's credential through the
// platform's hosting (./modules.ts), by 0.12's own introspection: the reading
// listen-fire's 0.12 runner gives a module. Production's platform added three
// passes over that reading which this package does not carry: demand scoping
// (it read only the types a program names), WHERE refinements (a narrowed
// walk typed at the narrowed type) and an ask's answer typed by its own
// literals. So an instance read here is typed at its full, unrefined surface;
// a construction with an entry position, and ask, stay gaps, said out loud.
// Without the platform's hosting (a check with no modules handed in), every
// connected system is a gap.

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
import { moduleTable } from './modules';
import type { ModulePlatform } from './run_types';
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

/** One connection a program makes: the adapter, the credential import name
 *  it is made with, and whether it pins an entry position. */
export interface ConstructedInstance {
  adapter: string;
  credentialName?: string;
  positioned: boolean;
}

/** What `program` connects: its constructions anywhere, through the names its
 *  `adapters` import binds. A construction whose callee is no adapter in
 *  `adapters` (a call to a movement reads the same) is not a connection. */
export function constructedInstances(program: Program, adapters: ReadonlySet<string>): ConstructedInstance[] {
  const imported = new Map<string, string>();
  for (const statement of program.statements) {
    if (statement.kind !== 'import' || statement.source.kind !== 'builtin' || statement.source.namespace !== 'adapters') continue;
    for (const name of statement.names) imported.set(name.alias ?? name.name, name.name.replace(/^@lf\//, ''));
  }
  const constructions: ConstructionCall[] = [];
  constructionsIn(program.statements, constructions);
  return constructions.flatMap(({ callee, args }) => {
    const adapter = imported.get(callee) ?? callee;
    if (!adapters.has(adapter)) return [];
    const credential = args.find((arg) => arg.name === 'credentials')?.value.raw.replace(/^`(.*)`$/, '$1');
    return [{ adapter, ...(credential !== undefined ? { credentialName: credential } : {}), positioned: args.some((arg) => arg.name !== 'credentials') }];
  });
}

/** What `program` connects, by adapter key. */
export function constructedAdapters(program: Program, adapters: ReadonlySet<string>): string[] {
  return [...new Set(constructedInstances(program, adapters).map((instance) => instance.adapter))];
}

/** How a check or a run reads the connected systems its programs construct:
 *  through the platform's hosting of 0.12's modules, as the team. */
export interface ConnectedReading {
  teamId: string;
  modules: ModulePlatform;
  programs: readonly Program[];
}

/** Adapters a connection is never read for here: ask's answers are typed by
 *  its own literals in production, which this package does not carry. */
const NOT_READ: ReadonlySet<string> = new Set(['ask']);

// A team's connected schemas, shared for a minute: an editor's keystrokes and
// a run's checks read each connection once.
const READ_TTL_MS = 60_000;
const readSchemas = new Map<string, { at: number; reading: Promise<{ schema: InstanceSchema; notes: string[] }> }>();

function readOnce(key: string, read: () => Promise<{ schema: InstanceSchema; notes: string[] }>) {
  const cached = readSchemas.get(key);
  if (cached !== undefined && Date.now() - cached.at < READ_TTL_MS) return cached.reading;
  const reading = read();
  readSchemas.set(key, { at: Date.now(), reading });
  reading.catch(() => readSchemas.delete(key));
  return reading;
}

/** Each connection `reading.programs` make that can be read, read: its
 *  schema by adapter and credential key, and why any could not be. */
async function readConnected(
  reading: ConnectedReading,
  team: TeamFacts,
  manifests: readonly AdapterManifest[],
  described: ReadonlySet<string>,
): Promise<{ schemas: Map<string, Record<string, InstanceSchema>>; notes: string[]; unread: Map<string, string> }> {
  const adapters = new Set(manifests.map((manifest) => manifest.adapterType));
  const byName = credentialImportNames({ rows: [...team.credentials], manifests: [...manifests] });
  const table = moduleTable(reading.modules);
  const schemas = new Map<string, Record<string, InstanceSchema>>();
  const notes: string[] = [];
  const unread = new Map<string, string>();
  const seen = new Set<string>();
  for (const instance of reading.programs.flatMap((program) => constructedInstances(program, adapters))) {
    if (described.has(instance.adapter)) continue;
    const key = `${instance.adapter}|${instance.credentialName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (NOT_READ.has(instance.adapter)) {
      unread.set(instance.adapter, `production typed ${instance.adapter}'s answers by each construction's own literals, which this platform does not do for 0.12`);
      continue;
    }
    if (instance.positioned) {
      unread.set(instance.adapter, 'a construction that pins an entry position is read only through production\'s demand passes, which this platform does not carry for 0.12');
      continue;
    }
    const manifest = manifests.find((m) => m.adapterType === instance.adapter);
    const credential = instance.credentialName !== undefined ? byName[instance.credentialName] : undefined;
    if (manifest === undefined || (instance.credentialName !== undefined && credential === undefined)) continue;
    const credentialsId = credential?.id;
    try {
      const read = await readOnce(`${reading.teamId}|${instance.adapter}|${credentialsId ?? ''}`, () =>
        introspectAdapter(
          table.resolve(instance.adapter, { teamId: reading.teamId, ...(credentialsId !== undefined ? { credentialsId } : {}) }),
          manifest,
        ),
      );
      notes.push(...read.notes);
      schemas.set(instance.adapter, {
        ...(schemas.get(instance.adapter) ?? {}),
        [instanceSchemaKey({ ...(instance.credentialName !== undefined ? { credentialName: instance.credentialName } : {}) })]: read.schema,
      });
    } catch (error) {
      unread.set(instance.adapter, `0.12's module for it could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { schemas, notes, unread };
}

export interface TeamSnapshot {
  snapshot: CatalogSnapshot;
  notes: string[];
  /** The adapter keys whose instances this snapshot types. */
  typed: ReadonlySet<string>;
  /** Why a connected adapter could not be read, by adapter key. */
  unread: ReadonlyMap<string, string>;
  /** Every adapter key the snapshot names. */
  adapters: ReadonlySet<string>;
}

/** The team's 0.12 snapshot, with `files` as the import namespace. */
export async function teamSnapshot(
  team: TeamFacts,
  files: Record<string, { source: string }>,
  reading?: ConnectedReading,
): Promise<TeamSnapshot> {
  const notes: string[] = [];
  const manifests = manifestsOf(team);
  const schemas = await describedSchemas();
  const connected =
    reading !== undefined ? await readConnected(reading, team, manifests, new Set(schemas.keys())) : { schemas: new Map<string, Record<string, InstanceSchema>>(), notes: [], unread: new Map<string, string>() };
  notes.push(...connected.notes);
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
    const read = connected.schemas.get(manifest.adapterType);
    if (read !== undefined) return { ...entry, schemas: read };
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
    typed: new Set([...schemas.keys(), ...connected.schemas.keys()]),
    unread: connected.unread,
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
      `nothing this language 0.12 automation reads from or writes to ${adapter} was checked: ` +
      (snapshot.unread.get(adapter) ?? `this platform reads ${adapter} for a 0.12 automation only through 0.12's own module for it, which this check did not reach`),
  }));
}
