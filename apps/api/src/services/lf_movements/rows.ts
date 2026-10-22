// Which of a team's movements lf is served, and at which text. One rule for
// list and read, so a path list would not name reads null. A movement is
// served when all hold:
//
//   • it is shipped (it has a current version), and it is served at that
//     version's text: a save that stopped at the consent gate is a draft, not
//     what the author shipped;
//   • its current version's pin is compatible with the installed language: an
//     older line stays on the platform's own engine, and lf checks every file
//     under lf.yaml's one pin;
//   • none of its listeners is paused (run mode off, or the loop guard): lf has
//     no per-listener pause, so serving it would resume what the pause stopped;
//   • `<name>.mvt` is a movement path, so lf can name it (and import it by
//     `<name>`, which is the platform's own import-by-name).
//
// The version is the text's content hash, so the same text keeps its version
// across a repin and a revert, and a list reads no text. Every statement is
// held to the one team: the module never reaches another tenant's rows.

import { sql } from 'kysely';
import { LANGUAGE_VERSION, compatible } from 'movement-lang';
import { isMovementPath } from 'engine-contracts/slots';

import { logger } from 'movement-engine/public/log';

import { getAutomationsQb } from '../../lib/kysely';

export interface ServedMovementsTenant {
  readonly tenant: string;
}

const MVT = '.mvt';

/** The team's shipped, unpaused movements with their current version, outside
 *  any transaction a request context might hold. */
function shippedMovements(tenant: string) {
  return getAutomationsQb(['movement', 'movement_version', 'trigger'])
    .selectFrom('movement as m')
    .innerJoin('movement_version as v', 'v.id', 'm.current_version_id')
    .where('m.team_id', '=', tenant)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('trigger as t')
            .select(sql<number>`1`.as('one'))
            .whereRef('t.movement_id', '=', 'm.id')
            .where((paused) => paused.or([paused('t.run_mode', '=', 'off'), paused('t.guard_paused_at', 'is not', null)])),
        ),
      ),
    );
}

const servedPin = (pin: string) => compatible(pin, LANGUAGE_VERSION);

/** What `movements.list` answers: a path and version per served movement. */
export async function servedMovements({ tenant }: ServedMovementsTenant): Promise<Array<{ path: string; version: string }>> {
  const rows = await shippedMovements(tenant)
    .select(['m.name as name', 'v.content_hash as version', 'v.language_version as pin'])
    .orderBy('m.name')
    .execute();
  const served: Array<{ path: string; version: string }> = [];
  const unnamed: string[] = [];
  for (const row of rows) {
    if (!servedPin(row.pin)) continue;
    const path = `${row.name}${MVT}`;
    if (!isMovementPath(path)) {
      unnamed.push(row.name);
      continue;
    }
    served.push({ path, version: row.version });
  }
  if (unnamed.length > 0) {
    logger.warn('[slots:movements] movements left out: their names are not movement paths', {
      count: unnamed.length,
      names: unnamed,
    });
  }
  return served;
}

/** What `movements.read` answers for a movement path: the served text and its
 *  version, or null when the rule would not list it. */
export async function servedMovement(
  { tenant }: ServedMovementsTenant,
  path: string,
): Promise<{ text: string; version: string } | null> {
  if (!path.endsWith(MVT) || !isMovementPath(path)) return null;
  const row = await shippedMovements(tenant)
    .where('m.name', '=', path.slice(0, -MVT.length))
    .select(['v.source as text', 'v.content_hash as version', 'v.language_version as pin'])
    .executeTakeFirst();
  if (row === undefined || !servedPin(row.pin)) return null;
  return { text: row.text, version: row.version };
}
