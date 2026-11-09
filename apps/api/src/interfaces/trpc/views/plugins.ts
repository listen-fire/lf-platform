/**
 * tRPC surface for the `/plugins` page — the catalogue of bundled plugins
 * (transform implementations) a movement can import via the `plugins`
 * namespace: `import { vc_url_retrieval } from plugins`.
 *
 * Reads the static per-plugin manifests registered alongside the
 * transforms (`listPluginManifests()` in
 * `services/translation_graph/engine/transforms/register-bundled.ts`) —
 * the plugin twin of the adapter-manifest pattern. Parameter and addition
 * declarations reference each plugin's signature, so what this view
 * reports can't drift from what the engine actually runs.
 */

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { EXEMPT, decidesEach } from '../../access_route';

export type PluginCatalogEntry = {
  /** Registry name the engine dispatches on (e.g. `vc-url-retrieval`). */
  pluginName: string;
  /** The name a movement imports: `import { <importName> } from plugins`. */
  importName: string;
  name: string;
  description: string;
  /** Plain-language account of what the plugin adds to the data it runs on. */
  contextAdditions: string;
  params: {
    name: string;
    required: boolean;
    description: string;
  }[];
};

const pluginsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    list: userProcedure.query(async (): Promise<PluginCatalogEntry[]> => {
      // Lazy require — the bundled plugin modules pull in the LLM/scraper
      // service chain, which shouldn't load at view-module import time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { listPluginManifests } =
        require('../../../services/translation_graph/engine/transforms/register-bundled') as typeof import('../../../services/translation_graph/engine/transforms/register-bundled');

      return listPluginManifests()
        .map((m): PluginCatalogEntry => ({
          pluginName: m.pluginName,
          importName: m.importName,
          name: m.displayName,
          description: m.description,
          contextAdditions: m.contextAdditions,
          // Exclude `auto` params — engine-injected from the source, not
          // author-passable. Mirrors the catalog's filter (movement/catalog.ts).
          params: m.params
            .filter((p) => !p.auto)
            .map((p) => ({
              name: p.name,
              required: p.required ?? false,
              description: p.description ?? '',
            })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
  });
};

decidesEach('plugins', {
  list: EXEMPT.teamCatalog,
});

export { pluginsRouter };
