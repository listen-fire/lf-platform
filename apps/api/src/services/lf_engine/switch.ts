// Switching a team between the platform and a cloud lf. The one entry for the
// settings page and the operator CLI, so both leave the same audit entry.

import { writeTeamEngine, type TeamEngine } from './team_engine';

export interface TeamEngineSwitch {
  engine: TeamEngine;
  /** Whether this call changed the setting (false: it already was `engine`). */
  changed: boolean;
}

export async function switchTeamEngine(
  teamId: string,
  change: { engine: TeamEngine; changedBy: string | null },
): Promise<TeamEngineSwitch> {
  const { previous } = await writeTeamEngine(teamId, change);
  return { engine: change.engine, changed: previous !== change.engine };
}
