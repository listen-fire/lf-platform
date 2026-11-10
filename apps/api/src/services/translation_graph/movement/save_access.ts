// Who may save a file, decided before any of it is stored, and what a save
// tells its author about who its statements reach.
//
// A person's save is decided here; a run's (an upgrade, the deploy sweep, a
// script) is not, since nobody is authoring, and what a run creates gets the
// statements a creation with no person gets. Saving over an automation is a
// write on it, by id or by name. Creating one needs its read, write and fire
// statements. Every connection the file and the files it imports name needs
// `use`: an imported function runs against its own file's connections, and
// without this anyone could save their own automation on a connection they
// may not use and read everything through it.

import { credentialImportNames } from 'movement-engine/public/catalog';

import type { AdapterManifest } from 'movement-engine/public/adapter';
import type { Principal } from 'principal';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CatalogAudience } from './audience';
import type { ProvisionedListener } from './provision';
import type { ListenReach } from '../../access/no_person';

import { accessTo, membersAdmitted, stateAtCreation, type CreationStatements } from '../../access/decide';
import { automationLists, automationWithNoPerson } from '../../access/no_person';
import { isLfEngineTeam } from '../../lf_engine/team_engine';
import { StatementStore, type Grantee, type StatedVerb, type Target } from '../../access/statement';
import { CRON_ADAPTER_TYPE } from '../adapters/cron';
import { EMAIL_ADAPTER_TYPE } from '../adapters/email';
import { hasAdapter, indexManifestsByName, resolveAdapterSlug } from '../adapters/registry';
import { getRemoteAdapter } from '../adapters/remote/store';
import { SYSTEM_ADAPTER_TYPE } from '../adapters/system';
import { teamAdapterManifests } from '../adapters/team_manifests';
import { constructionsOf, loadCredentialRows } from './catalog';
import { assembleMovementFileSources } from './files';
import { getMovementRowByName, type MovementRow } from './store';

/** Why a person's save was refused. Nothing of the text was stored. */
export type SaveRefusal =
  | { kind: 'read_only' }
  | { kind: 'name_taken'; name: string }
  | { kind: 'name_gone'; name: string }
  | { kind: 'missing_statement'; missing: StatedVerb<'automation'>[] }
  | { kind: 'statement'; message: string }
  | { kind: 'connections'; connections: { connection: string; file: string }[]; unreadableFiles: string[] };

/** The person a save is decided for: nobody when a run saves. */
export function saverOf(audience: CatalogAudience): Principal | undefined {
  return audience.for === 'run' ? undefined : audience.for;
}

/**
 * What a person's save over `row` is refused by: `unseen` when they may not
 * read it, so the save answers exactly as it would for nothing there.
 */
export async function overwriteRefusal(saver: Principal, row: MovementRow): Promise<'unseen' | 'read_only' | undefined> {
  const target: Target<'automation'> = { thing: 'automation', id: row.id };
  if (await accessTo(saver, { target, verb: 'write' })) return undefined;
  return (await accessTo(saver, { target, verb: 'read' })) ? 'read_only' : 'unseen';
}

export const READ_ONLY_REFUSAL = 'You may read this automation but not change it.';

/** A save by name over an automation the saver may not see: the name is taken, which is all it says. */
export function nameTakenRefusal(name: string): string {
  return `The name "${name}" is taken. Save under another name.`;
}

/** Statements given to a save that overwrites: they say who may reach a new automation, so they apply only when creating. */
export const STATEMENTS_ON_OVERWRITE_REFUSAL =
  'Statements apply only when creating an automation. Change who may read, write or fire this one with setAccess.';

/** A save by name over an automation that was deleted while it was being saved: nothing is created in its place. */
export function nameGoneRefusal(name: string): string {
  return `The automation named "${name}" was deleted while you were saving it, so nothing was saved. Save again to create it.`;
}

const STATED_VERBS = ['read', 'write', 'fire'] as const satisfies readonly StatedVerb<'automation'>[];

/** All three statements a new automation is created with, or the ones it still lacks. */
export function creationStatements(
  given: Partial<CreationStatements> | undefined,
): { statements: CreationStatements } | { missing: StatedVerb<'automation'>[] } {
  const { read, write, fire } = given ?? {};
  if (read !== undefined && write !== undefined && fire !== undefined) return { statements: { read, write, fire } };
  return { missing: STATED_VERBS.filter((verb) => given?.[verb] === undefined) };
}

export function missingStatementRefusal(missing: readonly StatedVerb<'automation'>[]): string {
  return `A new automation needs a statement of who may ${missing.join(', ')} it. Ask the person you are working for, then save again with it.`;
}

/** How a file reaches a connection: by its name, or through a module's own install. */
type Reach = { connection: string } | { module: string };

/** A connection one file names, and the row it names when there is one. */
interface NamedConnection {
  file: string;
  /** The row of an imported file; undefined for the file being saved. */
  fileId: string | undefined;
  reach: Reach;
  /** Undefined when nothing by that name exists. */
  id: string | undefined;
}

function described(reach: Reach): string {
  return 'connection' in reach ? reach.connection : `${reach.module}'s own connection`;
}

/**
 * Every connection the file and the files it imports name, as the save's
 * check reads them: what each constructs `using`, and a remote module's own
 * install connection where a construction names none (that is the one its
 * calls are signed with). Resolved against every connection the team holds,
 * whoever may use it.
 */
export async function connectionsNamed(input: { teamId: string; file: string; source: string }): Promise<NamedConnection[]> {
  const teamId = input.teamId as TeamId;
  const importedIds = new Map<string, string>();
  const imports = await assembleMovementFileSources({
    rootSource: input.source,
    load: async (path) => {
      const row = await getMovementRowByName({ teamId: input.teamId, name: path });
      if (row !== null) importedIds.set(path, row.id);
      return row?.source ?? null;
    },
  });
  const files: [string, string][] = [[input.file, input.source], ...imports];
  const constructed = files.flatMap(([file, source]) => constructionsOf(source).map((ref) => ({ file, ref })));
  if (constructed.length === 0) return [];

  const manifests = await teamAdapterManifests(teamId, []);
  const byName = credentialImportNames({ rows: await loadCredentialRows(teamId, { for: 'run' }), manifests });
  const named = new Map<string, NamedConnection>();
  for (const { file, ref } of constructed) {
    const fileId = importedIds.get(file);
    let found: NamedConnection | undefined;
    if (ref.credential !== undefined) {
      found = { file, fileId, reach: { connection: ref.credential }, id: byName[ref.credential]?.id };
    } else if (!hasAdapter(ref.adapter)) {
      const install = await getRemoteAdapter({ teamId, adapterType: resolveAdapterSlug(ref.adapter) });
      if (install !== null && install.credentials_id !== null) found = { file, fileId, reach: { module: ref.adapter }, id: install.credentials_id };
    }
    if (found !== undefined) named.set(`${found.file}\u0000${described(found.reach)}`, found);
  }
  return [...named.values()];
}

/**
 * The listens a file may have, as far as its text says before it is checked:
 * each module it constructs stands for a listen on it. That can only make the
 * fire list a run creates it with narrower than its listens alone would.
 */
function listenReachesOf(source: string): ListenReach[] {
  return constructionsOf(source).map((ref) => ({ module: ref.adapter, viaConnection: ref.credential !== undefined }));
}

/**
 * State what a run's save creates: the statements it was given, when it was
 * given all three, else what a creation with no person gets. One or two of
 * the three is refused as a programming error.
 */
export async function stateRunCreation(created: {
  teamId: string;
  target: Target<'automation'>;
  source: string;
  given: Partial<CreationStatements> | undefined;
}): Promise<void> {
  const given = creationStatements(created.given);
  // Some of the three is a caller's mistake, not a request for the defaults:
  // carrying on would drop what they stated without a word.
  if ('missing' in given && given.missing.length < STATED_VERBS.length) {
    throw new Error(`A run's save was given only some of the statements: ${given.missing.join(', ')} missing. Give all three, or none.`);
  }
  const statements =
    'statements' in given
      ? given.statements
      : automationWithNoPerson({ listens: listenReachesOf(created.source), runsOnLf: await isLfEngineTeam(created.teamId) });
  await stateAtCreation(created.target, { teamId: created.teamId, lists: automationLists(statements) });
}

/** The named connections the saver may not use; one that does not exist is one they may not use. */
export async function unusableConnections(saver: Principal, named: readonly NamedConnection[]): Promise<NamedConnection[]> {
  const unusable: NamedConnection[] = [];
  for (const connection of named) {
    const { id } = connection;
    if (id === undefined || !(await accessTo(saver, { target: { thing: 'connection', id }, verb: 'use' }))) {
      unusable.push(connection);
    }
  }
  return unusable;
}

/**
 * The refusal for connections a save may not name. A connection named in a
 * file the saver may not read is not named: the refusal says only that a file
 * this imports names one, since naming the connection would show them what
 * that file reads through.
 */
export async function connectionsRefusal(
  saver: Principal,
  unusable: readonly NamedConnection[],
): Promise<{ refused: SaveRefusal; message: string }> {
  const visible: { connection: string; file: string }[] = [];
  const unreadableFiles = new Set<string>();
  for (const c of unusable) {
    const readable = c.fileId === undefined || (await accessTo(saver, { target: { thing: 'automation', id: c.fileId }, verb: 'read' }));
    if (readable) visible.push({ connection: described(c.reach), file: c.file });
    else unreadableFiles.add(c.file);
  }
  const sentences: string[] = [];
  if (visible.length > 0) {
    const listed = visible.map((c) => `"${c.connection}" (named in "${c.file}")`).join(', ');
    sentences.push(`This file names connections you may not use, or that do not exist: ${listed}.`);
  }
  if (unreadableFiles.size > 0) {
    sentences.push(`A file this imports names a connection you may not use: ${[...unreadableFiles].join(', ')}.`);
  }
  sentences.push('A save may name only connections you may use.');
  return {
    refused: { kind: 'connections', connections: visible, unreadableFiles: [...unreadableFiles] },
    message: sentences.join(' '),
  };
}

export { inOneTransaction } from '../../context/one_transaction';

/** Whether a module says who acted on what it delivers. */
function reportsActor(manifest: AdapterManifest | undefined): boolean {
  return manifest !== undefined && (manifest.methods.includes('getActorCandidates') || manifest.methods.includes('extractActor'));
}

/** Whether nobody acts on what a listen hears, so who may fire it is never judged from an actor. */
function nobodyActs(kind: string): boolean {
  return kind === CRON_ADAPTER_TYPE || kind === SYSTEM_ADAPTER_TYPE;
}

function restricts(fire: readonly Grantee[]): boolean {
  return fire.length > 0 && !fire.some((grantee) => grantee.kind === 'anyone');
}

function listenOf(listener: Pick<ProvisionedListener, 'kind' | 'movementName'>): string {
  return `the ${listener.kind} listen firing ${listener.movementName}`;
}

/** What a listen under a fire statement other than anyone tells the author, if anything. */
function fireWarning(listener: Pick<ProvisionedListener, 'kind' | 'movementName'>, manifests: ReadonlyMap<string, AdapterManifest>): string | undefined {
  if (nobodyActs(listener.kind)) return undefined;
  if (resolveAdapterSlug(listener.kind) === EMAIL_ADAPTER_TYPE) {
    return `Who may fire this automation names people, a team or a domain, and ${listenOf(listener)} hears email: a sender's address is claimed, not proven, until the email rework, so anyone writing as an allowed address can fire it.`;
  }
  if (!reportsActor(manifests.get(resolveAdapterSlug(listener.kind)))) {
    return `Who may fire this automation names people, a team or a domain, but ${listenOf(listener)} hears from a module that does not say who acted, so that rule cannot be applied to it.`;
  }
  return undefined;
}

/**
 * What a shipped save tells its author about who its statements reach. Never a
 * refusal: who may read the automation and who may use its connections are the
 * author's to choose.
 */
export async function accessWarnings(input: {
  teamId: string;
  automationId: string;
  named: readonly NamedConnection[];
  listeners: readonly Pick<ProvisionedListener, 'kind' | 'movementName'>[];
}): Promise<string[]> {
  const { teamId } = input;
  const automation: Target<'automation'> = { thing: 'automation', id: input.automationId };
  const warnings: string[] = [];

  const connections = new Map(input.named.flatMap((c) => (c.id === undefined ? [] : [[c.id, described(c.reach)] as const])));
  if (connections.size > 0) {
    const readers = await membersAdmitted(teamId, [
      { verb: 'read', grantees: await StatementStore.grantsOf(automation, { teamId, verb: 'read' }) },
      { verb: 'write', grantees: await StatementStore.grantsOf(automation, { teamId, verb: 'write' }) },
    ]);
    for (const [id, connection] of connections) {
      const use = await StatementStore.grantsOf({ thing: 'connection', id }, { teamId, verb: 'use' });
      const users = await membersAdmitted(teamId, [{ verb: 'use', grantees: use }]);
      if ([...readers].some((reader) => !users.has(reader))) {
        warnings.push(
          `Some who may read this automation may not use the connection "${connection}": its runs show them what it reads through that connection.`,
        );
      }
    }
  }

  const fire = await StatementStore.grantsOf(automation, { teamId, verb: 'fire' });
  if (restricts(fire) && input.listeners.length > 0) {
    const manifests = indexManifestsByName(await teamAdapterManifests(teamId as TeamId, []));
    for (const listener of input.listeners) {
      const warning = fireWarning(listener, manifests);
      if (warning !== undefined) warnings.push(warning);
    }
  }
  return warnings;
}
