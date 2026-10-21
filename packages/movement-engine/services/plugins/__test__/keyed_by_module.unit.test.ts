// Plugins are keyed by module and name: two modules may both serve a `render`,
// and a bare name still reaches the one plugin that has it.

import type { PluginSpec } from 'movement-lang';

import { pluginKey } from 'movement-lang';
import { pluginSpecNamed } from '../../movement_engine/segment_context';
import { bundledPluginSpecNamed, bundledPluginSpecs } from '../registry';

const spec = (tag: string): PluginSpec => ({ args: ['text'], priced: false, argTypes: { text: 'text' }, package: tag, name: 'render' });

describe('the engine finds a plugin by module and name', () => {
  const plugins = {
    [pluginKey('@lf/pdf', 'render')]: spec('@lf/pdf'),
    [pluginKey('@lf/web', 'render')]: spec('@lf/web'),
    fetch_url: { ...spec('@lf/web'), name: 'fetch_url' },
  };

  it('by the key a package import binds', () => {
    expect(pluginSpecNamed(plugins, '@lf/pdf/render')?.package).toBe('@lf/pdf');
    expect(pluginSpecNamed(plugins, '@lf/web/render')?.package).toBe('@lf/web');
  });

  it('by a bare name only one plugin has, and not by one two have', () => {
    expect(pluginSpecNamed(plugins, 'fetch-url')?.name).toBe('fetch_url');
    expect(pluginSpecNamed(plugins, 'render')).toBeUndefined();
  });
});

describe('the platform catalog', () => {
  it('lists @lf/pdf and @lf/web render as two plugins', () => {
    const keys = Object.keys(bundledPluginSpecs());
    expect(keys).toEqual(expect.arrayContaining(['@lf/pdf/render', '@lf/web/fetch_url']));
    expect(bundledPluginSpecNamed('@lf/pdf/render')?.package).toBe('@lf/pdf');
    expect(bundledPluginSpecNamed('fetch-url')?.package).toBe('@lf/web');
  });
});
