// What this release no longer runs, as a deploy names it: the automations
// pinned to a version it reads only through legacy-lang's frozen parser (a
// legacy id, or 0.12, whose engine it dropped), and their runs still parked. A
// parked one cannot continue here, whatever it waits on, so the deploy refuses
// to go on while one is (scripts/deploy_check.ts): it is answered, or
// cancelled, on the release that parked it first.

import { PLATFORM_SUPPORTED_LANGUAGE_VERSIONS } from 'legacy-lang';
import type { LanguageVersion } from 'movement-lang';

import { getAutomationsQb } from '../../../lib/kysely';
import { DROPPED_RELEASE_KEY } from './language_route';

export interface DroppedPins {
  automations: Array<{ id: string; teamId: string; name: string; pin: LanguageVersion }>;
  /** Runs this platform steps (not a team's own runner), parked on a dropped pin. */
  parkedRuns: Array<{ id: string; teamId: string; automation: string; pin: LanguageVersion }>;
}

const LEGACY_IDS: readonly LanguageVersion[] = [...PLATFORM_SUPPORTED_LANGUAGE_VERSIONS];
const DROPPED_RELEASES = `${DROPPED_RELEASE_KEY}.%`;

export async function droppedPins(): Promise<DroppedPins> {
  const automations = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where((eb) => eb.or([eb('language_version', 'in', LEGACY_IDS), eb('language_version', 'like', DROPPED_RELEASES)]))
    .select(['id', 'team_id', 'name', 'language_version'])
    .orderBy('team_id')
    .orderBy('name')
    .execute();
  const parkedRuns = await getAutomationsQb(['trigger_run', 'movement_version', 'movement'])
    .selectFrom('trigger_run')
    .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
    .innerJoin('movement', 'movement.id', 'movement_version.movement_id')
    .where('trigger_run.host', '=', 'platform')
    .where('trigger_run.status', '=', 'parked')
    .where((eb) => eb.or([eb('movement_version.language_version', 'in', LEGACY_IDS), eb('movement_version.language_version', 'like', DROPPED_RELEASES)]))
    .select(['trigger_run.id', 'trigger_run.team_id', 'movement.name', 'movement_version.language_version'])
    .orderBy('trigger_run.id')
    .execute();
  return {
    automations: automations.map((row) => ({ id: row.id, teamId: row.team_id, name: row.name, pin: row.language_version })),
    parkedRuns: parkedRuns.map((row) => ({ id: row.id, teamId: row.team_id, automation: row.name, pin: row.language_version })),
  };
}
