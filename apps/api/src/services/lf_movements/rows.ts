// Which of a team's movements lf is served, and at which text. One rule for
// list and read, so a path list would not name reads null. A movement is
// served when all hold:
//
//   * it is shipped (it has a current version), and it is served at that
//     version's text: a save that stopped at the consent gate is a draft, not
//     what the author shipped;
//   * its current version's pin is compatible with the installed language: an
//     older line stays on the platform's own engine, and lf checks every file
//     under lf.yaml's one pin;
//   * `<name>.mvt` is a movement path, so lf can name it (and import it by
//     `<name>`, which is the platform's own import-by-name);
//   * every credential it imports is one the secrets module serves lf for this
//     team (lf_secrets/rows.ts `servedCredentials`): lf refuses a whole session
//     at open when a file names a credential the secrets module does not list,
//     so one such file would take the team's other movements down with it. A
//     file left out for this also leaves out what imports it, since lf would
//     refuse the dangling import the same way;
//   * none of its listeners is paused (run mode off, or the loop guard), unless
//     a served file imports it. lf has no per-listener pause, so serving a
//     paused file as a movement would resume what the pause stopped; but a
//     pause is about firing, not about being importable, so a file a served
//     file imports (directly or through other paused files) is served too, or
//     its importer would not resolve. Serving it as text does not fire its
//     listeners on the platform's side; lf runs the listeners it is given, which
//     is the cost of a library that also listens (a pure library has none).
//
// The version is the text's content hash, so the same text keeps its version
// across a repin and a revert. Every statement is held to the one team: the
// module never reaches another tenant's rows.

import { sql } from 'kysely';
import { LANGUAGE_VERSION, compatible, parseProgram, type ImportStatement } from 'movement-lang';
import { isMovementPath } from 'engine-contracts/slots';

import { logger } from 'movement-engine/public/log';

import { getAutomationsQb } from '../../lib/kysely';
import { servedCredentials } from '../lf_secrets/rows';

export interface ServedMovementsTenant {
  readonly tenant: string;
}

const MVT = '.mvt';

interface ShippedMovement {
  name: string;
  text: string;
  version: string;
  pin: string;
  paused: boolean;
}

/** The team's shipped movements with their current version and whether a
 *  listener of theirs is paused, outside any transaction a request context
 *  might hold. */
async function shippedMovements(tenant: string): Promise<ShippedMovement[]> {
  const rows = await getAutomationsQb(['movement', 'movement_version', 'trigger'])
    .selectFrom('movement as m')
    .innerJoin('movement_version as v', 'v.id', 'm.current_version_id')
    .where('m.team_id', '=', tenant)
    .select((eb) => [
      'm.name as name',
      'v.source as text',
      'v.content_hash as version',
      'v.language_version as pin',
      eb
        .exists(
          eb
            .selectFrom('trigger as t')
            .select(sql<number>`1`.as('one'))
            .whereRef('t.movement_id', '=', 'm.id')
            .where((paused) => paused.or([paused('t.run_mode', '=', 'off'), paused('t.guard_paused_at', 'is not', null)])),
        )
        .as('paused'),
    ])
    .orderBy('m.name')
    .execute();
  return rows;
}

const servedPin = (pin: string) => compatible(pin, LANGUAGE_VERSION);

/** What a file imports that decides whether it is served: the credentials it
 *  names (as the secrets module names them, not as the file aliases them) and
 *  the files it imports (by movement name). Null when the text does not parse
 *  at its pin: lf reports that itself, so it is served as it is. */
function importsOf(file: { text: string; pin: string }): { credentials: string[]; files: string[] } | null {
  let imports: ImportStatement[];
  try {
    imports = parseProgram(file.text, { languageVersion: file.pin }).statements.filter(
      (statement): statement is ImportStatement => statement.kind === 'import',
    );
  } catch {
    return null;
  }
  const credentials: string[] = [];
  const files: string[] = [];
  for (const statement of imports) {
    if (statement.source.kind === 'file') {
      const path = statement.source.path;
      files.push(path.endsWith(MVT) ? path.slice(0, -MVT.length) : path);
    } else if (statement.source.namespace === 'credentials') {
      credentials.push(...statement.names.map((imported) => imported.name));
    }
  }
  return { credentials, files };
}

/** The rule above, applied: the served movements by name. */
async function served(tenant: string): Promise<Map<string, ShippedMovement>> {
  const unnamed: string[] = [];
  const current = new Map<string, ShippedMovement>();
  for (const row of await shippedMovements(tenant)) {
    if (!servedPin(row.pin)) continue;
    if (!isMovementPath(`${row.name}${MVT}`)) {
      unnamed.push(row.name);
      continue;
    }
    current.set(row.name, row);
  }
  if (unnamed.length > 0) {
    logger.warn('[slots:movements] movements left out: their names are not movement paths', {
      count: unnamed.length,
      names: unnamed,
    });
  }

  const imports = new Map([...current].map(([name, row]) => [name, importsOf(row)]));
  const credentialNames = new Set((await servedCredentials(tenant)).map((credential) => credential.ref));
  const unserved = new Map<string, string[]>();
  for (const [name, found] of imports) {
    const missing = found?.credentials.filter((credential) => !credentialNames.has(credential)) ?? [];
    if (missing.length > 0) unserved.set(name, missing);
  }
  const leftOut = new Set(unserved.keys());
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, found] of imports) {
      if (leftOut.has(name) || !found?.files.some((file) => leftOut.has(file))) continue;
      leftOut.add(name);
      grew = true;
    }
  }
  if (leftOut.size > 0) {
    logger.warn('[slots:movements] movements left out: they import a credential the secrets module does not serve', {
      count: leftOut.size,
      names: [...leftOut],
      credentials: [...new Set([...unserved.values()].flat())],
    });
  }

  const listed = new Set<string>();
  const visit = (name: string) => {
    if (listed.has(name) || leftOut.has(name) || !current.has(name)) return;
    listed.add(name);
    for (const file of imports.get(name)?.files ?? []) visit(file);
  };
  for (const [name, row] of current) if (!row.paused) visit(name);

  return new Map([...current].filter(([name]) => listed.has(name)));
}

/** What `movements.list` answers: a path and version per served movement. */
export async function servedMovements({ tenant }: ServedMovementsTenant): Promise<Array<{ path: string; version: string }>> {
  return [...(await served(tenant)).values()].map((row) => ({ path: `${row.name}${MVT}`, version: row.version }));
}

/** What `movements.read` answers for a movement path: the served text and its
 *  version, or null when the rule would not list it. */
export async function servedMovement(
  { tenant }: ServedMovementsTenant,
  path: string,
): Promise<{ text: string; version: string } | null> {
  if (!path.endsWith(MVT) || !isMovementPath(path)) return null;
  const row = (await served(tenant)).get(path.slice(0, -MVT.length));
  return row === undefined ? null : { text: row.text, version: row.version };
}
