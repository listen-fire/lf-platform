// What a connection carries for the settings its module declares. The module
// reads them as construction arguments (Slack's `drop_own_messages`), so a
// setting belongs to the connection, whichever automation connects it: every
// automation on a connection hears the same way.
//
// Slack's setting is on for every Slack connection, existing and new. It is
// turned off by writing "off", never by removing the key, so the module's
// later default cannot turn it back on under the person who removed it.

import { sql } from 'kysely';
import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type { MovementId } from '../../generated/kysely/automations/Movement';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb } from '../../lib/kysely';
import { builtinModuleSettings, builtinModulesOfCredentialType } from '../translation_graph/adapters/builtin_modules';
import { resolveAdapterSlug } from '../translation_graph/adapters/registry';

/** Slack's setting: the app's own messages and reactions are not delivered. */
export const DROP_OWN_MESSAGES = 'drop_own_messages';

const ON = 'on';
const OFF = 'off';

const StoredSettings = z.record(z.string(), z.string());

export type ModuleSettings = z.infer<typeof StoredSettings>;

/** Whether a boolean setting's stored value is on: only "on" is. */
export function isOn(value: string | undefined): boolean {
  return value === ON;
}

/** The settings a new connection of this credential type is written with. */
export function settingsAtCreation(type: ExternalServiceType): ModuleSettings {
  return type === ExternalServiceType.SLACK && declaredFor(type).includes(DROP_OWN_MESSAGES) ? { [DROP_OWN_MESSAGES]: ON } : {};
}

/**
 * A stored cell with the declared defaults under it: a stored "off" stays off,
 * a key the cell lacks gets the default. For every row filled in place, which
 * may have been written before the module declared the setting.
 */
export function underDeclaredDefaults(type: ExternalServiceType, cell: unknown): ModuleSettings {
  return { ...settingsAtCreation(type), ...settingsOfCell(cell) };
}

/** The names of the settings the modules serving a credential type declare. */
function declaredFor(type: ExternalServiceType): string[] {
  return builtinModulesOfCredentialType(type).flatMap((adapterType) => builtinModuleSettings(adapterType));
}

/** A stored cell, read as settings: strings by name. A cell of any other shape is a stored fault, refused by name. */
export function settingsOfCell(cell: unknown): ModuleSettings {
  const parsed = StoredSettings.safeParse(cell);
  if (!parsed.success) throw new Error(`a connection's module_settings is not a map of strings: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * What the connection carries for the settings this module declares, or
 * undefined when it declares none or the call names no connection. A
 * connection that is gone, or on another team, carries none. A read that
 * fails fails the call: a connection never runs without the settings it has.
 */
export async function moduleSettingsFor(asked: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
}): Promise<ModuleSettings | undefined> {
  if (asked.credentialsId === undefined) return undefined;
  const declared = builtinModuleSettings(resolveAdapterSlug(asked.adapterType));
  if (declared.length === 0) return undefined;
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', asked.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', asked.teamId)
    .select('module_settings')
    .executeTakeFirst();
  if (row === undefined) return {};
  const stored = settingsOfCell(row.module_settings);
  return Object.fromEntries(Object.entries(stored).filter(([name]) => declared.includes(name)));
}

export type SettingChange = 'set' | 'not_found' | 'not_a_setting';

/**
 * Turn a connection's boolean setting on or off. Refused by name when no
 * module serving the connection's type declares it. The decision whether the
 * caller may change the connection is the route's, ahead of this.
 */
export async function setModuleSetting(change: { connectionId: string; name: string; on: boolean }): Promise<SettingChange> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', change.connectionId as ExternalServiceCredentialsId)
    .select(['team_id', 'type'])
    .executeTakeFirst();
  if (row === undefined) return 'not_found';
  if (!declaredFor(row.type).includes(change.name)) return 'not_a_setting';
  await getAutomationsQb(['external_service_credentials'])
    .updateTable('external_service_credentials')
    .set({ module_settings: sql`module_settings || ${JSON.stringify({ [change.name]: change.on ? ON : OFF })}::jsonb` })
    .where('id', '=', change.connectionId as ExternalServiceCredentialsId)
    .where('team_id', '=', row.team_id)
    .execute();
  return 'set';
}

/** A connection an automation listens on, with Slack's setting as it stands. */
export interface DropsOwnMessagesOn {
  connectionId: string;
  name: string;
  on: boolean;
}

/**
 * The connections this automation listens on whose module has Slack's
 * setting, and whether each drops its app's own messages. A listen bound to no
 * connection has none to speak of.
 */
export async function dropsOwnMessagesOn(automationId: string): Promise<DropsOwnMessagesOn[]> {
  const listens = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', '=', automationId as MovementId)
    .select(['kind', 'credentials_id'])
    .execute();
  const ids = [
    ...new Set(
      listens.flatMap((listen) =>
        listen.credentials_id !== null && builtinModuleSettings(resolveAdapterSlug(listen.kind)).includes(DROP_OWN_MESSAGES)
          ? [listen.credentials_id]
          : [],
      ),
    ),
  ];
  if (ids.length === 0) return [];
  const connections = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', 'in', ids)
    .select(['id', 'name', 'module_settings'])
    .orderBy('name')
    .execute();
  return connections.map((connection) => ({
    connectionId: String(connection.id),
    name: connection.name,
    on: isOn(settingsOfCell(connection.module_settings)[DROP_OWN_MESSAGES]),
  }));
}
