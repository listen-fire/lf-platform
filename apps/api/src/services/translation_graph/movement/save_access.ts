// Who may save a file, decided before any of it is stored, and what a save
// tells its author about who its statements reach.
//
// A person's save is decided here; a run's (an upgrade, the deploy sweep, a
// script) is not, since nobody is authoring, and what a run creates gets the
// statements a creation with no person gets. Saving over an automation is a
// write on it, by id or by name. Creating one needs its read and write
// statements. Every connection the file names, and every library it imports,
// needs `use`: without this anyone could save their own automation on a
// connection they may not use and read everything through it. Only what the
// file itself names is checked: use on a library covers the connections the
// library reaches, and the library's own names are held to its own standing
// when a run starts.

import { credentialImportNames } from 'movement-engine/public/catalog';
import { referencedFileImports } from 'legacy-lang';

import type { Principal } from 'principal';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CatalogAudience } from './audience';

import { accessTo, membersAdmitted, stateAtCreation, type CreationStatements, type StatementRefusal } from '../../access/decide';
import { automationLists, automationWithNoPerson, libraryUseWithNoPerson } from '../../access/no_person';
import { StatementStore, type DirectNames, type StatedVerb, type Target } from '../../access/statement';
import { hasAdapter, resolveAdapterSlug } from '../adapters/registry';
import { getRemoteAdapter } from '../adapters/remote/store';
import { teamAdapterManifests } from '../adapters/team_manifests';
import { constructionsOf, loadCredentialRows } from './catalog';
import { movementFileFacets } from './files';
import { getMovementRow, getMovementRowByName, type MovementRow } from './store';

/** Why a creation's statements were refused: the decision's own reasons, and statements given to a save that overwrites. */
export type StatementReason = StatementRefusal | 'on_overwrite' | 'first_export';

/** Why a person's save was refused. Nothing of the text was stored. */
export type SaveRefusal =
  | { kind: 'read_only' }
  | { kind: 'name_taken'; name: string }
  | { kind: 'name_gone'; name: string }
  | { kind: 'missing_statement'; missing: StatedVerb<'automation'>[] }
  | { kind: 'statement'; reason: StatementReason; message: string }
  | { kind: 'connections'; connections: { connection: string; file: string }[] }
  | { kind: 'libraries'; libraries: string[] };

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

/**
 * A save by name over an automation the saver may not see, or a creation
 * whose name is held: the name is taken, which is all it says.
 */
export function nameTakenRefusal(name: string): string {
  return `The name "${name}" is taken. Save under another name.`;
}

/** Statements given to a save that overwrites: they say who may reach a new automation, so they apply only when creating. */
export const STATEMENTS_ON_OVERWRITE_REFUSAL =
  'Statements apply only when creating an automation. Change who may read or write this one with setAccess.';

/** A save by name over an automation that was deleted while it was being saved: nothing is created in its place. */
export function nameGoneRefusal(name: string): string {
  return `The automation named "${name}" was deleted while you were saving it, so nothing was saved. Save again to create it.`;
}

const STATED_VERBS = ['read', 'write'] as const satisfies readonly StatedVerb<'automation'>[];

/**
 * Every statement a new automation is created with, or the ones it still
 * lacks. The use list is part of it only for a file that exports: there is no
 * default, so the save that adds the first export states it.
 */
export function creationStatements(
  given: Partial<CreationStatements> | undefined,
  options: { exports: boolean },
): { statements: CreationStatements } | { missing: StatedVerb<'automation'>[] } {
  const { read, write, use } = given ?? {};
  const missing: StatedVerb<'automation'>[] = [...STATED_VERBS.filter((verb) => given?.[verb] === undefined)];
  if (options.exports && use === undefined) missing.push('use');
  if (missing.length > 0) return { missing };
  if (read === undefined || write === undefined) throw new Error('a creation lacking read or write was not reported missing');
  return { statements: { read, write, ...(options.exports && use !== undefined ? { use } : {}) } };
}

export function missingStatementRefusal(missing: readonly StatedVerb<'automation'>[]): string {
  const library = missing.includes('use')
    ? ' A file that exports is a library: its use list says who may import and call it without reading its source.'
    : '';
  return `A new automation needs a statement of who may ${missing.join(', ')} it. Ask the person you are working for, then save again with it.${library}`;
}

/** The refusal for a save that adds a file's first export without stating who may use it. */
export const FIRST_EXPORT_REFUSAL =
  'This save adds the first export, which makes the file a library, and a library needs a statement of who may use it (import and call it without reading its source). Ask the person you are working for, then save again with statements: { use }.';

/** Whether the text exports anything: the file is a library. */
export function exportsSomething(source: string): boolean {
  return movementFileFacets(source).isLibrary;
}

/** How a file reaches a connection: by its name, or through a module's own install. */
type Reach = { connection: string } | { module: string };

/** A connection one file names, and the row it names when there is one. */
interface NamedConnection {
  file: string;
  reach: Reach;
  /** Undefined when nothing by that name exists. */
  id: string | undefined;
}

function described(reach: Reach): string {
  return 'connection' in reach ? reach.connection : `${reach.module}'s own connection`;
}

/**
 * Every connection the file itself names, as the save's check reads them:
 * what it constructs `using`, and a remote module's own install connection
 * where a construction names none (that is the one its calls are signed
 * with). Resolved against every connection the team holds, whoever may use
 * it. A library it imports is a name of its own (`librariesNamed`): use on
 * the library covers what the library reaches.
 */
export async function connectionsNamed(input: { teamId: string; file: string; source: string }): Promise<NamedConnection[]> {
  const teamId = input.teamId as TeamId;
  const constructed = constructionsOf(input.source).map((ref) => ({ file: input.file, ref }));
  if (constructed.length === 0) return [];

  const manifests = await teamAdapterManifests(teamId, []);
  const byName = credentialImportNames({ rows: await loadCredentialRows(teamId, { for: 'run' }), manifests });
  const named = new Map<string, NamedConnection>();
  for (const { file, ref } of constructed) {
    let found: NamedConnection | undefined;
    if (ref.credential !== undefined) {
      found = { file, reach: { connection: ref.credential }, id: byName[ref.credential]?.id };
    } else if (!hasAdapter(ref.adapter)) {
      const install = await getRemoteAdapter({ teamId, adapterType: resolveAdapterSlug(ref.adapter) });
      if (install !== null && install.credentials_id !== null) found = { file, reach: { module: ref.adapter }, id: install.credentials_id };
    }
    if (found !== undefined) named.set(`${found.file}\u0000${described(found.reach)}`, found);
  }
  return [...named.values()];
}

/** Whether the stored file exports anything. */
export async function fileExportsSomething(id: string): Promise<boolean> {
  const teamId = await StatementStore.teamOf({ thing: 'automation', id });
  if (teamId === undefined) return false;
  const row = await getMovementRow({ teamId, id });
  return row !== null && exportsSomething(row.source);
}

/** A library a file imports by name, and its row when there is one. */
export interface NamedLibrary {
  name: string;
  /** Undefined when no file of that name exists. */
  id: string | undefined;
}

/** The files the source's own import lines name, resolved against the team's files by name. */
export async function librariesNamed(input: { teamId: string; source: string }): Promise<NamedLibrary[]> {
  return Promise.all(
    [...new Set(referencedFileImports(input.source))].map(async (name) => ({
      name,
      id: (await getMovementRowByName({ teamId: input.teamId, name }))?.id,
    })),
  );
}

/** The libraries the saver may not use; one that does not exist is one they may not use. */
export async function unusableLibraries(saver: Principal, named: readonly NamedLibrary[]): Promise<NamedLibrary[]> {
  const unusable: NamedLibrary[] = [];
  for (const library of named) {
    const { id } = library;
    if (id === undefined || !(await accessTo(saver, { target: { thing: 'automation', id }, verb: 'use' }))) unusable.push(library);
  }
  return unusable;
}

export function librariesRefusal(unusable: readonly NamedLibrary[]): { refused: SaveRefusal; message: string } {
  const libraries = unusable.map((library) => library.name);
  return {
    refused: { kind: 'libraries', libraries },
    message: `This file imports libraries you may not use, or that do not exist: ${libraries.map((name) => `"${name}"`).join(', ')}. A save may import only libraries you may use.`,
  };
}

// How the checker reports a fault inside an imported file: on the importer's
// import line, in the library's name and with its own line number. A fault
// two levels down carries one such prefix per level, outermost first.
const IN_LIBRARY = /^"([^"]+)" line \d+: /;

/** The libraries a diagnostic's message passes through, outermost first. */
function librariesInMessage(message: string): string[] {
  const chain: string[] = [];
  for (let rest = message; ; ) {
    const match = IN_LIBRARY.exec(rest);
    if (match === null || match[1] === undefined) return chain;
    chain.push(match[1]);
    rest = rest.slice(match[0].length);
  }
}

/**
 * A diagnostic from inside a library the person may use but not read says so
 * and shows nothing of the library: not its line number, and not the text the
 * checker quotes from it. When the fault is deeper than the first library, the
 * first library on the way down that they may not read is the one named, and
 * what is below it stays unsaid. A person reads what they may read; a run's
 * own check (no person) reads everything. Every check that reports to a person
 * goes through this: validate, save, the carried route, the upgrade.
 */
export async function hideUnreadableLibraries<D extends { message: string }>(
  diagnostics: readonly D[],
  input: { teamId: string; audience: CatalogAudience },
): Promise<D[]> {
  const { audience } = input;
  if (audience.for === 'run') return [...diagnostics];
  const reader = audience.for;
  const unreadable = new Map<string, boolean>();
  const hidden = async (library: string): Promise<boolean> => {
    const known = unreadable.get(library);
    if (known !== undefined) return known;
    const row = await getMovementRowByName({ teamId: input.teamId, name: library });
    const hide = row !== null && !(await accessTo(reader, { target: { thing: 'automation', id: row.id }, verb: 'read' }));
    unreadable.set(library, hide);
    return hide;
  };
  return Promise.all(
    diagnostics.map(async (diagnostic) => {
      for (const library of librariesInMessage(diagnostic.message)) {
        if (!(await hidden(library))) continue;
        return {
          ...diagnostic,
          message: `The library "${library}" has a fault you cannot see: you may use it but not read it. Ask someone who may read it.`,
        };
      }
      return diagnostic;
    }),
  );
}

// A diagnostic line of a failed run's check: its code, the importer's line,
// then the library's own words.
const RUN_CHECK_LINE = /^(\s*\S+ \(line \d+\): )"([^"]+)" line \d+: .*$/;

/**
 * A run's failure as it is recorded. The record is read by everyone who may
 * read the importer, whether or not they may read the library the fault is in,
 * and a record cannot know who will read it: so a fault the check found inside
 * a library names the library and nothing of its lines. The library's readers
 * see the fault by checking it.
 */
export function withoutLibraryLines(message: string): string {
  return message
    .split('\n')
    .map((line) => line.replace(RUN_CHECK_LINE, (_whole, head: string, library: string) => `${head}The library "${library}" has a fault. Open the library to see it.`))
    .join('\n');
}

/**
 * What the stored file names directly, resolved to what exists: the input of
 * the standing check and of changing a library's use list. Nothing is hidden
 * here; whether a caller may be told which is for the caller to decide.
 */
export async function directNamesOf(id: string): Promise<DirectNames> {
  const target: Target<'automation'> = { thing: 'automation', id };
  const teamId = await StatementStore.teamOf(target);
  if (teamId === undefined) return { connections: [], libraries: [], unresolvedConnections: [] };
  const row = await getMovementRow({ teamId, id });
  if (row === null) return { connections: [], libraries: [], unresolvedConnections: [] };
  const [connections, libraries] = await Promise.all([
    connectionsNamed({ teamId, file: row.name, source: row.source }),
    librariesNamed({ teamId, source: row.source }),
  ]);
  return {
    connections: connections.flatMap((c) => (c.id === undefined ? [] : [{ thing: 'connection' as const, id: c.id }])),
    libraries: libraries.flatMap((l) => (l.id === undefined ? [] : [{ thing: 'automation' as const, id: l.id }])),
    unresolvedConnections: connections.flatMap((c) => (c.id === undefined ? [described(c.reach)] : [])),
  };
}

/**
 * State what a run's save creates: the statements it was given, when it was
 * given both, else what a creation with no person gets. One of the two is
 * refused as a programming error.
 */
export async function stateRunCreation(created: {
  teamId: string;
  target: Target<'automation'>;
  given: Partial<CreationStatements> | undefined;
  /** The text exports: it is a library, and a run's save has no person to ask for its use list. */
  exports: boolean;
  /** Only the use list is stated: the file already has the others. */
  only?: 'use';
}): Promise<void> {
  if (created.only === 'use') {
    await StatementStore.replaceGrants(created.target, { teamId: created.teamId, verb: 'use', grantees: libraryUseWithNoPerson() });
    return;
  }
  const given = creationStatements(created.given, { exports: created.exports });
  // One of the two is a caller's mistake, not a request for the defaults:
  // carrying on would drop what they stated without a word.
  if ('missing' in given && given.missing.filter((verb) => verb !== 'use').length < STATED_VERBS.length) {
    throw new Error(`A run's save was given only some of the statements: ${given.missing.join(', ')} missing. Give all, or none.`);
  }
  const defaults = automationWithNoPerson();
  const statements = 'statements' in given ? given.statements : created.exports ? { ...defaults, use: libraryUseWithNoPerson() } : defaults;
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

/** The refusal for connections a save may not name. */
export function connectionsRefusal(unusable: readonly NamedConnection[]): { refused: SaveRefusal; message: string } {
  const connections = unusable.map((c) => ({ connection: described(c.reach), file: c.file }));
  const listed = connections.map((c) => `"${c.connection}" (named in "${c.file}")`).join(', ');
  return {
    refused: { kind: 'connections', connections },
    message: `This file names connections you may not use, or that do not exist: ${listed}. A save may name only connections you may use.`,
  };
}

export { inOneTransaction } from '../../context/one_transaction';

/**
 * What a shipped save tells its author about who its statements reach. Never a
 * refusal: who may read the automation and who may use its connections are the
 * author's to choose.
 */
export async function accessWarnings(input: {
  teamId: string;
  automationId: string;
  named: readonly NamedConnection[];
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

  return warnings;
}
