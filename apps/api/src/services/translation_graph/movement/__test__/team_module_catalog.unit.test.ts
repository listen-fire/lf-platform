// `@lf-platform/team` is on the platform's table, so the catalog's adapters
// serve its declarations to the checker; a program on an older release is
// handed a snapshot without them, since that release's checker refuses a plugin
// spec with fields it does not know.

import { staticCatalogFromManifests } from '../catalog';
import { platformPluginModules } from '../../adapters/builtin_modules';
import { platformPluginSpecs, snapshotPluginSpecs } from '../plugin_specs';

const IS_MEMBER = '@lf-platform/team/is_member';
const USER_FOR = '@lf-platform/team/user_for';

describe('the team module in the catalog', () => {
  it('serves both functions through the catalog adapters, pure, with their brands', () => {
    const catalog = staticCatalogFromManifests();
    expect(catalog.pluginNames?.()).toEqual(expect.arrayContaining([IS_MEMBER, USER_FOR]));
    expect(catalog.plugin(IS_MEMBER)).toMatchObject({
      package: '@lf-platform/team',
      name: 'is_member',
      pure: true,
      maxAgeSeconds: 300,
      argTypes: {
        claim: {
          kind: 'union',
          of: [
            { kind: 'branded', of: 'text', brands: ['claim:email/address'] },
            { kind: 'branded', of: 'text', brands: ['claim:phone/e164'] },
          ],
        },
      },
      output: { kind: 'value', type: 'boolean' },
    });
    expect(catalog.plugin(USER_FOR)).toMatchObject({ pure: true, maxAgeSeconds: 300 });
    expect(catalog.plugin('is_member')).toMatchObject({ pure: true });
  });

  it('is the one platform plugin module the engine package does not bundle', () => {
    expect(platformPluginModules().map((module) => module.name)).toEqual(['@lf-platform/team']);
  });

  describe('the snapshot a program is checked against', () => {
    const live = platformPluginSpecs({ modules: platformPluginModules() });

    it('carries the functions, purity included, for the current release', () => {
      expect(snapshotPluginSpecs(live)[IS_MEMBER]).toMatchObject({ pure: true, maxAgeSeconds: 300 });
      expect(snapshotPluginSpecs(live, { languageVersion: '0.16.0' })[USER_FOR]).toMatchObject({ pure: true });
    });

    it.each(['1', '4', '0.15.3', '0.12.13'])('carries no function with purity for a program pinned to %s', (languageVersion) => {
      const snapshot = snapshotPluginSpecs(live, { languageVersion });
      expect(Object.keys(snapshot)).not.toContain(IS_MEMBER);
      expect(Object.keys(snapshot)).not.toContain(USER_FOR);
      expect(Object.values(snapshot).filter((spec) => 'pure' in spec || 'maxAgeSeconds' in spec)).toEqual([]);
      // What the older pins read of the bundled plugins is untouched.
      expect(Object.keys(snapshot)).toContain('@lf/web/fetch_url');
    });

    it('still gives a legacy pin the earlier outputs its checker reads', () => {
      expect(snapshotPluginSpecs(live, { languageVersion: '3' })['@lf/web/vc_url_retrieval']).toHaveProperty('earlierOutputs');
    });
  });
});
