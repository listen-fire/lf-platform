// The statements Task 9 writes for everything that exists: read and write for
// the team on an automation, use for the team on a connection. A thing with no statement admits nobody, so a helper that puts
// an automation or a connection in place directly states these beside it.

import { neverAsAny } from 'movement-engine/public/types';

import type { Target } from '../../services/access/statement';

import { StatementStore } from '../../services/access/statement';

async function stateTeamDefaults(target: Target, teamId: string): Promise<void> {
  const team = [{ kind: 'team' as const }];
  switch (target.thing) {
    case 'automation':
      await StatementStore.replaceGrants(target, { teamId, verb: 'write', grantees: team });
      await StatementStore.replaceGrants(target, { teamId, verb: 'read', grantees: team });
      return;
    case 'connection':
      await StatementStore.replaceGrants(target, { teamId, verb: 'use', grantees: team });
      return;
    default:
      return neverAsAny(target.thing);
  }
}

export { stateTeamDefaults };
