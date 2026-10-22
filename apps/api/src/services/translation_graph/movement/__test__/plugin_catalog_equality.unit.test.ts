// The plugin catalog both checkers see, held against a recording taken from the
// code before plugin specs moved into the engine package as data (Plan 22 #3
// C3). Three views, because each is read by a different consumer: the snapshot
// a run checks against (the Rust checker's input), the live catalog's answers
// by either spelling (the TypeScript checker's input), and what both checkers
// say about a call to each plugin. Re-record only on a deliberate change to a
// plugin's surface: PLUGIN_CATALOG_RECORD=1.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

import * as fs from 'fs';
import * as path from 'path';

import { LANGUAGE_VERSION, type PluginSpec } from 'movement-lang';
import { pinOf } from '../../../movement_engine/__test__/pin_of';
import { spelledFor } from 'legacy-lang/checker/__test__/surface_spelling';

import { diagnoseMovementSource } from '../authoring';
import { platformPluginSpecs } from '../plugin_specs';
import { staticCatalogFromManifests, staticCatalogSnapshot } from '../catalog';

const FIXTURE = path.join(__dirname, '__fixtures__', 'plugin_catalog.json');

function callingProgram(plugin: string, spec: PluginSpec, withArgs: boolean): string {
  const names = withArgs ? [...spec.args, ...(spec.fedArgs ?? []).map((a) => a.name)] : [];
  const args = names.map((name) => `${name}: "x"`).join(', ');
  return `import { ${plugin} } from plugins
movement m() {
  r = ${plugin}(${args})
  return r
}
`;
}

function observe(): unknown {
  const catalog = staticCatalogFromManifests();
  const snapshot = staticCatalogSnapshot();
  const specs = platformPluginSpecs();
  const names = Object.keys(specs).sort();

  const written = (key: string): string => specs[key]?.name ?? key;
  // A name two packages serve is not a bare import (the catalog refuses it);
  // those are held by the package tests below.
  const ambiguous = (key: string): boolean => names.filter((other) => written(other) === written(key)).length > 1;

  const liveCatalog = Object.fromEntries(
    names.flatMap((key) => {
      const dashed = written(key).replace(/_/g, '-');
      return [
        [key, catalog.plugin(key) ?? null],
        ...(ambiguous(key) ? [] : [[dashed, catalog.plugin(dashed) ?? null]]),
      ];
    }),
  );

  const versions = [4, 5] as const;
  const diagnostics: Record<string, unknown> = {};
  for (const key of names) {
    const spec = specs[key]!;
    const name = written(key);
    if (ambiguous(key)) continue;
    for (const withArgs of [false, true]) {
      const source = callingProgram(name, spec, withArgs);
      for (const behaviour of versions) {
        const languageVersion = pinOf(behaviour);
        const spelled = spelledFor(languageVersion, source, catalog);
        const key = `${name} ${withArgs ? 'every argument' : 'no argument'} v${behaviour}`;
        diagnostics[`${key} typescript`] = diagnoseMovementSource(spelled, { catalog, languageVersion }).diagnostics;
        if (behaviour >= 5) {
          diagnostics[`${key} rust`] = diagnoseMovementSource(spelled, { catalog, languageVersion, snapshot }).diagnostics;
        }
      }
    }
  }

  return JSON.parse(
    JSON.stringify({ registeredPluginSpecs: specs, snapshotPlugins: snapshot.plugins, liveCatalog, diagnostics }),
  );
}

describe('the plugin catalog the checkers see', () => {
  it('is the recorded one', () => {
    const observed = observe();
    if (process.env.PLUGIN_CATALOG_RECORD === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    }
    const recorded: unknown = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    expect(observed).toEqual(recorded);
  });
});

// The bundled plugins are one module, `@lf/web` (modules/web): a movement
// imports them one by one, as it always has, or as the package, and both
// checkers read the same members off the hosted catalog.
describe('two packages that each serve a render', () => {
  const imports = (tag: string, as: string) => `import { \`${tag}\` as ${as} } from plugins
function m(t: <text>) {
  r = ${as}.render(t)
  return r
}
`;

  it.each([
    ['@lf/pdf', 'pdf'],
    ['@lf/web', 'web'],
  ])('checks %s render clean in both checkers', (tag, as) => {
    const catalog = staticCatalogFromManifests();
    const snapshot = staticCatalogSnapshot();
    expect(diagnoseMovementSource(imports(tag, as), { catalog, languageVersion: LANGUAGE_VERSION }).diagnostics).toEqual([]);
    expect(diagnoseMovementSource(imports(tag, as), { catalog, languageVersion: LANGUAGE_VERSION, snapshot }).diagnostics).toEqual([]);
  });

  it('refuses a bare import of render, naming both packages, in both checkers', () => {
    const source = `import { render } from plugins
function m(t: <text>) {
  r = render(t)
  return r
}
`;
    const catalog = staticCatalogFromManifests();
    const snapshot = staticCatalogSnapshot();
    for (const options of [{ catalog, languageVersion: LANGUAGE_VERSION }, { catalog, languageVersion: LANGUAGE_VERSION, snapshot }]) {
      const messages = diagnoseMovementSource(source, options).diagnostics.map((d) => d.message).join('\n');
      expect(messages).toContain('served by more than one package (@lf/web, @lf/pdf)');
    }
  });
});

describe('the bundled plugins as a package', () => {
  const program = (imports: string, call: string) => `${imports}
function m(u: <text>) {
  r = ${call}
  return r
}
`;

  it.each([
    ['one by one', program('import { fetchUrl } from plugins', 'fetchUrl(u)')],
    ['as the package', program('import { `@lf/web` as web } from plugins', 'web.fetchUrl(u)')],
  ])('checks clean %s, in both checkers', (_how, source) => {
    const catalog = staticCatalogFromManifests();
    const snapshot = staticCatalogSnapshot();
    expect(diagnoseMovementSource(source, { catalog, languageVersion: LANGUAGE_VERSION }).diagnostics).toEqual([]);
    expect(diagnoseMovementSource(source, { catalog, languageVersion: LANGUAGE_VERSION, snapshot }).diagnostics).toEqual([]);
  });

  it('names its members when one is missing', () => {
    const source = program('import { `@lf/web` as web } from plugins', 'web.whisper(u)');
    const messages = diagnoseMovementSource(source, { catalog: staticCatalogFromManifests(), languageVersion: LANGUAGE_VERSION }).diagnostics.map((d) => d.message);
    expect(messages.join('\n')).toMatch(/has no member `whisper`.*fetchUrl/);
  });
});
