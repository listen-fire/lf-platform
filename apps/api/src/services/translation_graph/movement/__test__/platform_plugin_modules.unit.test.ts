// A plugin module the platform hosts itself reaches the checker as a bundled
// one does: its declarations are the catalog's specs (purity and maximum age
// included), and the in-process lookup serves it by its key.

import { defineModule } from 'module-kit';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import { builtinPluginModule, platformPluginModules, type BuiltinModuleTable } from '../../adapters/builtin_modules';
import { platformPluginSpecNamed, platformPluginSpecs, snapshotPluginSpecs } from '../plugin_specs';

const team = defineModule({
  kind: 'plugin',
  name: '@lf-platform/team',
  credentials: [],
  plugins: [
    {
      priced: false,
      pure: true,
      maxAgeSeconds: 60,
      signature: {
        name: 'is-member',
        params: [{ name: 'claim', type: { kind: 'string' }, required: true }],
        dataDependency: 'none',
        additions: {},
        output: { kind: 'value', type: { kind: 'boolean' } },
      },
    },
  ],
  create: () => ({ invokePlugin: async () => ({ outcome: 'ok' }) }),
});

const KEY = '@lf-platform/team/is_member';
const TABLE: BuiltinModuleTable = { [KEY]: { kind: 'plugin', line: 'module', load: () => team } };

describe('a platform plugin module', () => {
  it('a_platform_plugin_module_is_in_the_catalog', () => {
    const modules = platformPluginModules(TABLE);
    expect(modules).toEqual([team]);
    const specs = platformPluginSpecs({ modules });
    expect(specs[KEY]).toMatchObject({ package: '@lf-platform/team', name: 'is_member', pure: true, maxAgeSeconds: 60 });
    expect(platformPluginSpecNamed(KEY, { modules })).toMatchObject({ pure: true });
    expect(platformPluginSpecNamed('is_member', { modules })).toMatchObject({ pure: true });
    expect(Object.keys(platformPluginSpecs())).not.toContain(KEY);
  });

  it('keeps purity and maximum age in the snapshot the checker takes', () => {
    const snapshot = snapshotPluginSpecs(platformPluginSpecs({ modules: [team] }));
    expect(snapshot[KEY]).toMatchObject({ pure: true, maxAgeSeconds: 60 });
  });

  it('is served in process by its key', () => {
    expect(builtinPluginModule(KEY, { teamId: 'team-1' as TeamId }, TABLE)).toBeDefined();
    expect(builtinPluginModule('@lf-platform/team/nope', { teamId: 'team-1' as TeamId }, TABLE)).toBeUndefined();
  });
});
