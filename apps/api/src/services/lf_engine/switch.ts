// Switching a team between the platform and a cloud lf. The one entry for the
// settings page and the operator CLI, so both leave the same audit entry and
// the same registrations behind.
//
// After the setting is stored, the team's vendor registrations follow it: the
// listen-subscription sync tears every webhook it provisioned down for an
// lf-engined team (deregistering at the vendor where the adapter can) and
// provisions them again for a team back on the platform. The poll scanner
// reads the setting itself; a team coming back has its poll progress
// forgotten, so the platform's first poll does not replay what lf handled.
//
// The sync runs on every call, a repeat of the current engine included, so
// pressing the switch again retries a deregistration a vendor refused.

import type { TeamId } from '../../generated/kysely/core/Team';

import { syncListenSubscriptions } from '../translation_graph/movement/listen_subscriptions';
import { forgetPollProgress } from '../poll_source/worker';
import { writeTeamEngine, type TeamEngine } from './team_engine';

export interface TeamEngineSwitch {
  engine: TeamEngine;
  /** Whether this call changed the setting (false: it already was `engine`). */
  changed: boolean;
  /** What the vendor registrations could not do, one line each. Empty when
   *  every webhook was registered or removed as the engine requires. */
  notes: string[];
}

export async function switchTeamEngine(
  teamId: string,
  change: { engine: TeamEngine; changedBy: string | null },
): Promise<TeamEngineSwitch> {
  const { previous } = await writeTeamEngine(teamId, change);
  const team = teamId as TeamId;
  if (previous === 'lf' && change.engine === 'platform') await forgetPollProgress(team);
  const { notes } = await syncListenSubscriptions({ teamId: team });
  return { engine: change.engine, changed: previous !== change.engine, notes };
}
