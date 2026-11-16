// The plugin specs the platform's catalogs serve: the engine package's, plus
// what the legacy ids still read of a plugin's past. The language serves
// version 5 and later only, so its spec carries no older output shapes; a
// program pinned to a legacy id is checked by legacy-lang's checker, which
// reads them (`earlierOutputsOf`).
//
// The live catalog (the TypeScript checker's input) always carries them. A
// snapshot carries them only when built for a legacy id: the snapshot is the
// Rust checker's and engine's input too, and the installed language refuses a
// plugin spec with a field it does not know.

import { LANGUAGE_VERSION, findPlugin, pluginKey, type LanguageVersion, type PluginSpec } from 'movement-lang';
import { isLegacyLanguageVersion, type EarlierOutput, type LegacyPluginSpec } from 'legacy-lang';
import { bundledPluginSpecs, pluginProgramName } from 'movement-engine/public/plugins';
import { pluginSpecsOf } from 'engine-contracts/plugin_spec';
import type { PluginModuleDefinition } from 'module-kit';

/** Keyed as the catalog keys a plugin (`@lf/web/vc_url_retrieval`). */
const EARLIER_OUTPUTS: Readonly<Record<string, readonly EarlierOutput[]>> = {
  // Before version 2 a plain call to vc_url_retrieval handed back the fetched
  // text, if any; from 2 it hands back the pages it found, as records.
  '@lf/web/vc_url_retrieval': [{ before: 2, output: { kind: 'value', type: { kind: 'maybeAbsent', of: 'text' } } }],
};

function withEarlierOutputs(key: string, spec: PluginSpec): LegacyPluginSpec {
  const earlierOutputs = EARLIER_OUTPUTS[key];
  return earlierOutputs !== undefined ? { ...spec, earlierOutputs } : spec;
}

/** Plugin modules the platform hosts itself, beside the engine package's
 *  bundled ones. */
export interface PlatformPluginModules {
  modules?: readonly PluginModuleDefinition[];
}

/** What a platform plugin module's declarations are to the checker, keyed and
 *  tagged as a bundled plugin is (purity and maximum age ride the spec). */
function platformModuleSpecs(modules: readonly PluginModuleDefinition[]): Record<string, PluginSpec> {
  return Object.fromEntries(
    modules.flatMap((definition) =>
      Object.entries(pluginSpecsOf(definition.plugins)).map(([name, spec]): [string, PluginSpec] => [
        pluginKey(definition.name, name),
        { ...spec, package: definition.name, name },
      ]),
    ),
  );
}

/** Every catalog plugin's checker surface, keyed the way a program spells it. */
export function platformPluginSpecs(options: PlatformPluginModules = {}): Record<string, LegacyPluginSpec> {
  return Object.fromEntries(
    Object.entries({ ...bundledPluginSpecs(), ...platformModuleSpecs(options.modules ?? []) }).map(([key, spec]) => [
      key,
      withEarlierOutputs(key, spec),
    ]),
  );
}

/** A catalog plugin's checker surface by its key or by a bare name only one
 *  package serves. */
export function platformPluginSpecNamed(name: string, options: PlatformPluginModules = {}): LegacyPluginSpec | undefined {
  // A key is written as it is (a package name may carry a dash); a bare name is
  // its program spelling.
  const specs = platformPluginSpecs(options);
  const hit = findPlugin(specs, name) ?? findPlugin(specs, pluginProgramName(name));
  return hit !== undefined && 'found' in hit ? hit.found.spec : undefined;
}

/** `plugins` as a snapshot built for `languageVersion` carries them (by
 *  default the installed release, which carries none). */
export function snapshotPluginSpecs(
  plugins: Readonly<Record<string, LegacyPluginSpec>>,
  options: { languageVersion?: LanguageVersion } = {},
): Record<string, PluginSpec> {
  if (isLegacyLanguageVersion(options.languageVersion ?? LANGUAGE_VERSION)) return { ...plugins };
  return Object.fromEntries(
    Object.entries(plugins).map(([key, { earlierOutputs: _dropped, ...spec }]) => [key, spec]),
  );
}
