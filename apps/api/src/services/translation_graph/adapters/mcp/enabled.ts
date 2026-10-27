// The deployment switch for MCP connections. Off by default: the platform
// offers no MCP servers until an operator turns it on. Read once at boot, so
// the adapter tables and the connect forms agree for the life of the process.

export const MCP_SWITCH = 'MCP_CONNECTIONS_ENABLED';

export const MCP_CONNECTIONS_ENABLED = process.env[MCP_SWITCH] === 'true';

/** What a refusal says when something reaches for MCP on a deployment with
 *  the switch off. */
export const MCP_DISABLED_MESSAGE = `MCP servers are not enabled on this deployment (set ${MCP_SWITCH}=true to turn them on).`;

const IMPORTS_MCP_ADAPTER = /^[ \t]*import[ \t]*\{[^}]*\bmcp\b[^}]*\}[ \t]*from[ \t]+adapters\b/m;

/** The refusal for a firing of a movement that imports the mcp adapter where
 *  the switch is off, or undefined. Read only to name the cause in a failure
 *  that is coming anyway (the adapter is not registered); it decides nothing. */
export function mcpDisabledRefusal(source: string): string | undefined {
  return !MCP_CONNECTIONS_ENABLED && IMPORTS_MCP_ADAPTER.test(source) ? MCP_DISABLED_MESSAGE : undefined;
}
