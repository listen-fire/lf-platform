// A team's systems as 0.12 reads them, for an agent working on a 0.12
// automation: the catalog view production served at 0.12.13
// (`toAgentCatalogView`), and one system as compact text in the digest's
// notation (`connection_digest.ts` at main).
//
// A system is read whole, through 0.12's own module (./../modules.ts). What
// production walked on top of that (a position, a narrowing, per-type demand)
// is not carried for 0.12, so a request for one says so instead of answering
// from another version.

import { introspectAdapter } from '@listen-fire/engine/public/embed';
import { credentialImportNames } from '@listen-fire/engine/public/catalog';
import { spellName, type AdapterSpec, type InstanceSchema, type SchemaFieldType } from '@listen-fire/movement-lang';

import { readOnce, teamSnapshot, type TeamSnapshot } from '../catalog';
import { moduleTable } from '../modules';
import type { ModulePlatform } from '../run_types';
import type { TeamFacts } from '../types';

export interface SystemsRequest {
  team: TeamFacts;
  teamId: string;
  modules: ModulePlatform;
}

function emptySnapshot(team: TeamFacts): Promise<TeamSnapshot> {
  return teamSnapshot({ team, files: {}, sources: [] });
}

/** What a program on 0.12 can connect, by adapter key. */
export async function catalogOf(team: TeamFacts) {
  const { snapshot, notes } = await emptySnapshot(team);
  return {
    adapters: Object.fromEntries(
      Object.entries(snapshot.adapters).map(([slug, spec]) => [
        slug,
        {
          constructionArgs: spec.constructionArgs,
          requiresCredential: spec.constructionArgs.some((arg) => arg.kind === 'credential' && arg.required),
          ...(spec.connect !== undefined ? { connect: spec.connect } : {}),
          ...(spec.triggerExpectation !== undefined ? { triggerExpectation: spec.triggerExpectation } : {}),
          ...(spec.schemaShape !== undefined ? { schemaShape: spec.schemaShape } : {}),
        },
      ]),
    ),
    credentials: snapshot.credentials,
    plugins: snapshot.plugins,
    notes,
  };
}

function connectionsFor(snapshot: TeamSnapshot['snapshot'], system: string): string[] {
  return Object.entries(snapshot.credentials)
    .filter(([, credential]) => ('adapters' in credential ? credential.adapters.includes(system) : credential.adapter === system))
    .map(([name]) => name);
}

/** `crm = connect attio using acme`: how 0.12 connects a system, with the
 *  arguments its construction requires named. */
function connectSpelling(system: string, spec: Pick<AdapterSpec, 'constructionArgs'>, connections: readonly string[]): string {
  const usesCredential = spec.constructionArgs.some((arg) => arg.kind === 'credential');
  const named = spec.constructionArgs.filter((arg) => arg.kind !== 'credential' && arg.required).map((arg) => `${arg.name}: …`);
  const using = usesCredential ? ` using ${connections[0] ?? '…'}` : '';
  const positioned = named.length > 0 ? ` { ${named.join(', ')} }` : '';
  const others = connections.slice(1);
  return `\`connect ${system}${using}${positioned}\`${others.length > 0 ? ` (other connections: ${others.join(', ')})` : ''}`;
}

function listenSpelling(spec: Pick<AdapterSpec, 'triggerConfig' | 'triggerConfigOptions' | 'triggerConfigRequired'>): string | null {
  const keys = spec.triggerConfig ?? [];
  if (keys.length === 0) return null;
  const required = new Set(spec.triggerConfigRequired ?? []);
  const parts = keys.map((key) => {
    const options = spec.triggerConfigOptions?.[key];
    const mark = required.has(key) ? '!' : '';
    return options !== undefined && options.length > 0 ? `${key}${mark}: ${options.join('|')}` : `${key}${mark}`;
  });
  return `listen { ${parts.join(', ')} }`;
}

function compactType(type: SchemaFieldType): string {
  if (typeof type === 'string') return type === 'absent' ? 'null' : type;
  switch (type.kind) {
    case 'list':
      return `${compactType(type.of)}[]`;
    case 'maybeAbsent':
      return `${compactType(type.of)}?`;
    case 'enum':
      return `enum(${type.options.slice(0, 4).join('|')}${type.options.length > 4 ? `|…+${type.options.length - 4}` : ''})`;
    default:
      return type.kind;
  }
}

const FIELDS_SHOWN = 40;

function positionLines(schema: InstanceSchema): string[] {
  return Object.entries(schema.positions).map(([name, position]) => {
    const fields = Object.entries(position.properties);
    const shown = fields.slice(0, FIELDS_SHOWN).map(([field, type]) => `${spellName(field)} ${compactType(type)}`);
    const more = fields.length > FIELDS_SHOWN ? `, …+${fields.length - FIELDS_SHOWN}` : '';
    const edges = Object.keys(position.edges);
    const reach = edges.length > 0 ? ` → ${edges.map((edge) => spellName(edge)).join(', ')}` : '';
    const words = position.undescribed === true ? 'not described' : shown.length > 0 ? `${shown.join(', ')}${more}` : 'no fields';
    return `- ${spellName(position.displayName ?? name)}: ${words}${reach}`;
  });
}

export interface DescribeRequest extends SystemsRequest {
  system: string;
  connection?: string;
}

/** The schema of `system` as 0.12's module for it describes it, with why it
 *  could not be read when it could not. */
async function readSystem(input: DescribeRequest, snapshot: TeamSnapshot['snapshot']): Promise<{ schema?: InstanceSchema; notes: string[] }> {
  const described = Object.values(snapshot.adapters[input.system]?.schemas ?? {})[0];
  if (described !== undefined) return { schema: described, notes: [] };
  const { manifests } = await teamSnapshot({ team: input.team, files: {}, sources: [] });
  const manifest = manifests.find((m) => m.adapterType === input.system);
  if (manifest === undefined) return { notes: [`${input.system}: not a system 0.12 knows`] };
  const byName = credentialImportNames({ rows: [...input.team.credentials], manifests: [...manifests] });
  const candidates = Object.entries(byName).filter(([, row]) => row.adapters.includes(input.system));
  const chosen = input.connection !== undefined ? candidates.find(([name]) => name === input.connection) : candidates[0];
  if (manifest.requiredCredentialType !== undefined && chosen === undefined) {
    return {
      notes: [
        input.connection !== undefined
          ? `${input.system}: no connection named ${input.connection} on this team`
          : `${input.system}: this team has no connection for it, so its records are not read`,
      ],
    };
  }
  const credentialsId = chosen?.[1].id;
  try {
    const read = await readOnce(`${input.teamId}|${input.system}|${credentialsId ?? ''}`, () =>
      moduleTable(input.modules)
        .resolve(input.system, { teamId: input.teamId, ...(credentialsId !== undefined ? { credentialsId } : {}) })
        .then((adapter) => introspectAdapter(adapter, manifest)),
    );
    return { schema: read.schema, notes: read.notes };
  } catch (error) {
    return { notes: [`${input.system}: 0.12's module for it could not be read (${error instanceof Error ? error.message : String(error)})`] };
  }
}

/** One system, as compact text an agent writes a 0.12 program against. */
export async function describeSystem(input: DescribeRequest): Promise<string> {
  const { snapshot, manifests } = await emptySnapshot(input.team);
  const spec = snapshot.adapters[input.system];
  const manifest = manifests.find((m) => m.adapterType === input.system);
  if (spec === undefined || manifest === undefined) {
    return `### ${input.system}\nNot a system language 0.12 knows on this platform. Systems it knows: ${Object.keys(snapshot.adapters).join(', ')}.`;
  }
  const connections = input.connection !== undefined ? [input.connection] : connectionsFor(snapshot, input.system);
  const read = await readSystem(input, snapshot);
  const lines = [`### ${input.system} — import it \`from adapters\`, then ${connectSpelling(input.system, spec, connections)}`];
  if (manifest.description) lines.push(manifest.description);
  const listen = listenSpelling(spec);
  if (listen !== null) lines.push(`- ${listen}`);
  if (manifest.triggerExpectation) lines.push(`- What a listen fires on: ${manifest.triggerExpectation}`);
  if (manifest.authoringHints) lines.push(`- Hint: ${manifest.authoringHints}`);
  if (read.schema !== undefined) {
    if (read.schema.supportsInPlaceUpdate !== true) lines.push('- Records here cannot be updated in place: a write creates.');
    const positions = positionLines(read.schema);
    if (positions.length > 0) lines.push('Record types:', ...positions);
    const collections = Object.keys(read.schema.collections);
    if (collections.length > 0) lines.push(`Reached from the instance: ${collections.map((name) => `-[:${spellName(name)}]->`).join(', ')}`);
  }
  for (const note of read.notes) lines.push(`Note: ${note}`);
  return lines.join('\n');
}

/** Within `ms`, or null: one slow connection cannot hold the first read up. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_TIMEOUT_MS = 8_000;
const SYSTEM_DIGEST_CHAR_CAP = 1_600;

/** Every system the team can use on 0.12, connected first; one it has not
 *  connected is only named. */
export async function connectionsDigest(input: SystemsRequest): Promise<string> {
  const { snapshot } = await emptySnapshot(input.team);
  const blocks: Promise<string>[] = [];
  const notConnected: string[] = [];
  for (const [system, spec] of Object.entries(snapshot.adapters)) {
    const needsCredential = spec.constructionArgs.some((arg) => arg.kind === 'credential' && arg.required);
    if (needsCredential && connectionsFor(snapshot, system).length === 0) {
      notConnected.push(spec.connect === 'app-only' ? `${system} (connects in the app)` : system);
      continue;
    }
    blocks.push(
      within(describeSystem({ ...input, system }), SYSTEM_TIMEOUT_MS).then((block) => {
        const text = block ?? `### ${system}\nIts records took too long to load.`;
        return text.length > SYSTEM_DIGEST_CHAR_CAP ? `${text.slice(0, SYSTEM_DIGEST_CHAR_CAP)}… describeConnection("${system}") for more` : text;
      }),
    );
  }
  return [
    ...(await Promise.all(blocks)),
    ...(notConnected.length > 0 ? [`Not connected on this team: ${notConnected.join(', ')}.`] : []),
  ].join('\n\n');
}
