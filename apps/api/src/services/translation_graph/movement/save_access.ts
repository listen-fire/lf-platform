// Who may save a file, decided before any of it is stored, and what a save
// tells its author about who its statements reach.
//
// A person's save is decided here; a run's (an upgrade, the deploy sweep, a
// script) is not, since nobody is authoring. Saving over an automation is a
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

import { accessTo, membersAdmitted, type CreationStatements } from '../../access/decide';
import { StatementStore, type Grantee, type StatedVerb, type Target } from '../../access/statement';
import { Context, unsafeCurrentContext } from '../../context';
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
  | { kind: 'missing_statement'; missing: StatedVerb<'automation'>[] }
  | { kind: 'statement'; message: string }
  | { kind: 'connections'; connections: { connection: string; file: string }[] };

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
  const imports = await assembleMovementFileSources({
    rootSource: input.source,
    load: async (path) => (await getMovementRowByName({ teamId: input.teamId, name: path }))?.source ?? null,
  });
  const files: [string, string][] = [[input.file, input.source], ...imports];
  const constructed = files.flatMap(([file, source]) => constructionsOf(source).map((ref) => ({ file, ref })));
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

export function connectionsRefusal(unusable: readonly NamedConnection[]): { refused: SaveRefusal; message: string } {
  const connections = unusable.map((c) => ({ connection: described(c.reach), file: c.file }));
  const listed = connections.map((c) => `"${c.connection}" (named in "${c.file}")`).join(', ');
  return {
    refused: { kind: 'connections', connections },
    message: `This file names connections you may not use, or that do not exist: ${listed}. A save may name only connections you may use.`,
  };
}

/**
 * Run `fn` in one database transaction: the caller's open one, else one of
 * its own that commits when `fn` returns and rolls back when it throws.
 */
export async function inOneTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (unsafeCurrentContext()?.kyselyTrx !== undefined) return fn();
  const context = new Context();
  return context.runAsync(async () => {
    await context.enterTransaction();
    return fn();
  });
}

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
