// MCP connections are a deployment switch, read once at boot and off by
// default. Each state is loaded in its own module registry, as a boot would.

import ExternalServiceType from '../../../../../generated/kysely/automations/ExternalServiceType';

const PROGRAM = `import { mcp } from adapters
import { tracker } from credentials
t = connect mcp using tracker
`;

function bootedWith(switchValue: string | undefined) {
  const before = process.env.MCP_CONNECTIONS_ENABLED;
  if (switchValue === undefined) delete process.env.MCP_CONNECTIONS_ENABLED;
  else process.env.MCP_CONNECTIONS_ENABLED = switchValue;
  try {
    let booted: unknown;
    jest.isolateModules(() => {
      booted = {
        registry: require('../../registry'),
        formSpec: require('../../../../credentials/connect_form_spec'),
        catalog: require('../../../movement/catalog'),
        authoring: require('../../../movement/authoring'),
        mcp: require('..'),
      };
    });
    return booted as {
      registry: typeof import('../../registry');
      formSpec: typeof import('../../../../credentials/connect_form_spec');
      catalog: typeof import('../../../movement/catalog');
      authoring: typeof import('../../../movement/authoring');
      mcp: typeof import('..');
    };
  } finally {
    if (before === undefined) delete process.env.MCP_CONNECTIONS_ENABLED;
    else process.env.MCP_CONNECTIONS_ENABLED = before;
  }
}

function diagnose(platform: ReturnType<typeof bootedWith>) {
  const catalog = platform.catalog.staticCatalogFromManifests({ credentials: { tracker: { adapters: ['mcp'] } } });
  const snapshot = platform.catalog.snapshotOverManifests(catalog);
  return platform.authoring.diagnoseMovementSource(PROGRAM, { catalog, snapshot });
}

describe('with the MCP switch off (the default)', () => {
  const off = bootedWith(undefined);

  it('lists no mcp adapter', () => {
    expect(off.registry.listAdapterTypes()).not.toContain('mcp');
    expect(off.registry.listAdapterManifests().map((manifest) => manifest.adapterType)).not.toContain('mcp');
    expect(off.registry.hasAdapter('mcp')).toBe(false);
  });

  it('does not offer MCP servers to connect', () => {
    expect(off.formSpec.connectFormSpecForType(ExternalServiceType.MCP)).toBeUndefined();
    expect(off.formSpec.isKeyEntryConnectable(ExternalServiceType.MCP)).toBe(false);
  });

  it('refuses to store an MCP connection', () => {
    const parsed = off.mcp.mcpCredsParser.safeParse({ url: 'https://mcp.example.com/mcp', token: 't' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('MCP_CONNECTIONS_ENABLED');
  });

  it('refuses a movement that imports mcp, as any unknown adapter', () => {
    const validation = diagnose(off);
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics.map((d) => d.message).join('\n')).toMatch(/mcp/);
  });

  it('fails a firing that reaches for mcp, naming the switch', () => {
    expect(() => off.registry.getAdapter({ adapterType: 'mcp', teamId: 'team' as never })).toThrow(/MCP_CONNECTIONS_ENABLED/);
  });

  it('fails a firing of a movement that imports mcp before it starts, naming the switch', async () => {
    await expect(
      off.catalog.runCatalogSnapshotForTeam('team' as never, { source: PROGRAM, imports: 'shipped' }),
    ).rejects.toThrow(/MCP_CONNECTIONS_ENABLED/);
  });

  it('reads the switch only when it is exactly "true"', () => {
    expect(bootedWith('false').registry.hasAdapter('mcp')).toBe(false);
    expect(bootedWith('1').registry.hasAdapter('mcp')).toBe(false);
  });
});

describe('with the MCP switch on', () => {
  const on = bootedWith('true');

  it('lists the mcp adapter and offers its connect form', () => {
    expect(on.registry.listAdapterTypes()).toContain('mcp');
    expect(on.registry.listAdapterManifests().map((manifest) => manifest.adapterType)).toContain('mcp');
    expect(on.formSpec.isKeyEntryConnectable(ExternalServiceType.MCP)).toBe(true);
  });

  it('accepts an MCP connection and a movement that imports mcp', () => {
    expect(on.mcp.mcpCredsParser.safeParse({ url: 'https://mcp.example.com/mcp', token: 't' }).success).toBe(true);
    expect(diagnose(on).ok).toBe(true);
  });
});
