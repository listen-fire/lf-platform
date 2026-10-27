SET search_path = public, pg_catalog;

-- Add MCP to ExternalServiceType so a connection to an MCP server (@lf/mcp) can
-- store its server URL, token and optional header name in
-- automations.external_service_credentials. Each row is one server: a team
-- connects as many as it likes, each under its own name.
--
-- Hand-written: the generator cannot diff an enum value.
ALTER TYPE automations."ExternalServiceType" ADD VALUE IF NOT EXISTS 'MCP';
