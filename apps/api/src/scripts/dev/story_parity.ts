/**
 * The story parity over the active dev-loop stack's saved movements: every
 * current-pin row's story as the wasm's story analysis draws it, against the
 * story legacy-lang drew under its 0.12 dialect, through the same comparison the parity
 * test holds the corpus to. Read-only.
 *
 *   TZ=utc corepack pnpm exec ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register src/scripts/dev/story_parity.ts [--verbose]
 *
 * One line per row, then the hits per ruling; `--verbose` adds every ruled case.
 */
import './_profile_loader';
import '../../services';

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../generated/kysely/core/Team';
import { movementCatalogForTeam } from '../../services/translation_graph/movement/catalog';
import { routeOf } from '../../services/translation_graph/movement/language_route';
import { listAllMovementRows } from '../../services/translation_graph/movement/store';
import { storyFromAnalysis } from '../../services/translation_graph/movement/story_from_analysis';
import { compareStories, legacyStoryUnder5, rulingHits, type StoryComparison } from '../../services/translation_graph/movement/story_parity';

async function main(): Promise<void> {
  const verbose = process.argv.includes('--verbose');
  const rows = (await listAllMovementRows()).filter((row) => routeOf(row.languageVersion).kind === 'installed');
  const comparisons: StoryComparison[] = [];
  let differing = 0;
  for (const row of rows) {
    let teamCatalog;
    try {
      teamCatalog = await movementCatalogForTeam(row.teamId as TeamId, {
        source: row.source,
        languageVersion: row.languageVersion,
      });
    } catch (error) {
      differing += 1;
      console.log(`${row.id} ${row.name} (${row.languageVersion}): no catalog: ${String(error)}`);
      continue;
    }
    if (teamCatalog.runSnapshot === undefined) throw new Error(`no run snapshot for ${row.id}`);
    const snapshot = teamCatalog.runSnapshot();
    const comparison = compareStories(
      legacyStoryUnder5(row.source, snapshot),
      storyFromAnalysis({ source: row.source, snapshot, pin: row.languageVersion }).result,
    );
    comparisons.push(comparison);
    if (comparison.differences.length > 0) differing += 1;
    const verdict = comparison.differences.length === 0 ? 'same' : `${comparison.differences.length} differences`;
    console.log(`${row.id} ${row.name} (${row.languageVersion}): ${verdict}, ${comparison.ruled.length} ruled`);
    for (const d of comparison.differences) {
      console.log(`  DIFF ${d.path}: ${JSON.stringify(d.legacy)} != ${JSON.stringify(d.wasm)}`);
    }
    if (verbose) {
      for (const r of comparison.ruled) {
        console.log(`  ${r.ruling} ${r.path}: ${JSON.stringify(r.legacy)} -> ${JSON.stringify(r.wasm)}`);
      }
    }
  }
  console.log(
    `story parity: ${rows.length} current-pin rows (${LANGUAGE_VERSION} installed), ${differing} differing; hits ${JSON.stringify(rulingHits(comparisons))}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
