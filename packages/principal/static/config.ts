// Configuration for the static single-tenant provider (core plan §3): the
// zero-infrastructure identity a self-hoster gets when they run a product
// without core. Everything is read once, at boot, and anything malformed is a
// boot failure — a mis-set identity variable that degrades quietly is how a
// single-tenant install silently becomes an open one.

import { readFileSync } from 'node:fs';

import { isAccess, type Access } from '../principal';
import type { DirectoryUser } from '../directory';

/** The users the static Directory can answer for. They all belong to the one
 *  configured team — the stub is single-tenant by construction. */
interface StaticDirectoryConfig {
  team: { id: string; name: string };
  users: readonly DirectoryUser[];
}

interface StaticIdentityConfig {
  teamId: string;
  teamName: string;
  /** Attribution only — the static principal is otherwise a machine principal. */
  userId?: string;
  /** The single accepted secret. Absent only when `allowAnonymous`. */
  apiKey?: string;
  allowAnonymous: boolean;
  access: Access;
  scopes: readonly string[];
  directory: StaticDirectoryConfig;
}

type Env = Record<string, string | undefined>;

const DEFAULT_TEAM_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_TEAM_NAME = 'Local';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${where}: "${key}" must be a non-empty string.`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${where}: "${key}" must be a string.`);
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  where: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${where}: "${key}" must be a boolean.`);
  return value;
}

function parseDirectoryUsers(source: unknown, where: string): DirectoryUser[] {
  if (!isRecord(source)) throw new Error(`${where}: expected a JSON object with a "users" array.`);
  const { users } = source;
  if (!Array.isArray(users)) throw new Error(`${where}: "users" must be an array.`);

  return users.map((entry, index) => {
    const at = `${where}: users[${index}]`;
    if (!isRecord(entry)) throw new Error(`${at} must be an object.`);
    return {
      id: requiredString(entry, 'id', at),
      email: optionalString(entry, 'email', at),
      displayName: optionalString(entry, 'displayName', at),
      // A user listed in a local directory file is a member by construction;
      // the flag is there so a self-hoster can exercise the ungranted path.
      hasAccess: optionalBoolean(entry, 'hasAccess', at) ?? true,
    };
  });
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${where}: invalid JSON — ${detail}`);
  }
}

function envFlag(env: Env, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false" (got "${raw}").`);
}

function envAccess(env: Env): Access {
  const raw = env.LISTEN_FIRE_ACCESS;
  // A static install has one operator, who is the whole team, so the default is its manager.
  if (raw === undefined || raw === '') return 'admin';
  if (!isAccess(raw)) throw new Error(`LISTEN_FIRE_ACCESS must be "read", "write" or "admin" (got "${raw}").`);
  return raw;
}

function envScopes(env: Env): string[] {
  const raw = env.LISTEN_FIRE_SCOPES ?? '*';
  const scopes = raw
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
  if (scopes.length === 0) throw new Error('LISTEN_FIRE_SCOPES must name at least one scope.');
  return scopes;
}

function directoryFromEnv(env: Env, team: { id: string; name: string }): StaticDirectoryConfig {
  const file = env.LISTEN_FIRE_DIRECTORY_FILE;
  if (file !== undefined && file !== '') {
    const where = `LISTEN_FIRE_DIRECTORY_FILE (${file})`;
    return {
      team,
      users: parseDirectoryUsers(parseJson(readFileSync(file, 'utf8'), where), where),
    };
  }

  const userId = env.LISTEN_FIRE_USER_ID;
  if (userId === undefined || userId === '') return { team, users: [] };

  return {
    team,
    users: [
      {
        id: userId,
        email: env.LISTEN_FIRE_USER_EMAIL,
        displayName: env.LISTEN_FIRE_USER_NAME,
        hasAccess: true,
      },
    ],
  };
}

/**
 * Read the static identity out of the environment. Throws on anything
 * malformed or missing, so a misconfigured install fails at boot rather than
 * serving an identity nobody chose.
 */
function staticConfigFromEnv(env: Env): StaticIdentityConfig {
  const teamId = env.LISTEN_FIRE_TEAM_ID ?? DEFAULT_TEAM_ID;
  const teamName = env.LISTEN_FIRE_TEAM_NAME ?? DEFAULT_TEAM_NAME;
  const allowAnonymous = envFlag(env, 'LISTEN_FIRE_ALLOW_ANONYMOUS');
  const apiKey = env.LISTEN_FIRE_API_KEY;

  if ((apiKey === undefined || apiKey === '') && !allowAnonymous) {
    throw new Error('LISTEN_FIRE_API_KEY is required unless LISTEN_FIRE_ALLOW_ANONYMOUS=true.');
  }

  const userId = env.LISTEN_FIRE_USER_ID;

  return {
    teamId,
    teamName,
    userId: userId === '' ? undefined : userId,
    apiKey: apiKey === '' ? undefined : apiKey,
    allowAnonymous,
    access: envAccess(env),
    scopes: envScopes(env),
    directory: directoryFromEnv(env, { id: teamId, name: teamName }),
  };
}

export { type StaticIdentityConfig, type StaticDirectoryConfig, staticConfigFromEnv };
