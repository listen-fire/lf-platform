// What a thing is created with when no person is in the request: lf creating a
// secret, a remote module's credential minted by a harness, a team arriving
// by migration, a script saving an automation. Nobody chose who may reach it,
// so it keeps the reach a team has always had: the whole team, and firing as
// each listen's module allows it today. The backfill of what already exists
// gives the same, from here.

import { SLACK_ADAPTER_TYPE } from '@listen-fire/slack/types';
import { WHATSAPP_ADAPTER_TYPE } from '@listen-fire/whatsapp/types';

import type { CreationStatements, StatedList } from './decide';
import type { Grantee } from './statement';

import { resolveAdapterSlug } from '../translation_graph/adapters/registry';

/** One listen of an automation, as its source states it. */
type ListenReach = {
  /** The listen's module, by slug or by the kind a trigger row stores */
  module: string;
  /** Whether it hears through a connection of the team's own, rather than a shared one. */
  viaConnection: boolean;
};

const TEAM: readonly Grantee[] = [{ kind: 'team' }];
const ANYONE: readonly Grantee[] = [{ kind: 'anyone' }];

/**
 * Who may fire through one listen today. Slack's door already admits only
 * the team's members, as does the shared WhatsApp number (a sender's linked
 * phone finds the team); email's door checks the sender itself; every other
 * module admits whoever reaches it.
 */
function firedTodayBy(listen: ListenReach): 'team' | 'anyone' {
  const slug = resolveAdapterSlug(listen.module);
  if (slug === SLACK_ADAPTER_TYPE) return 'team';
  if (slug === WHATSAPP_ADAPTER_TYPE && !listen.viaConnection) return 'team';
  return 'anyone';
}

/** A connection created with no person in the request: the whole team may use it. */
function connectionWithNoPerson(): { use: readonly Grantee[] } {
  return { use: TEAM };
}

/**
 * An automation created with no person in the request: the whole team may
 * read and write it, and its fire list is the narrowest of its listens', so
 * nothing it was created with widens who could fire it. A file with no
 * listens fires nothing yet, and gets the narrower list. On a team whose
 * automations run on lf the platform judges no fire list, so it says anyone.
 */
function automationWithNoPerson(created: { listens: readonly ListenReach[]; runsOnLf: boolean }): CreationStatements {
  const everyListenAdmitsAnyone =
    created.listens.length > 0 && created.listens.every((listen) => firedTodayBy(listen) === 'anyone');
  return {
    write: TEAM,
    read: TEAM,
    fire: created.runsOnLf || everyListenAdmitsAnyone ? ANYONE : TEAM,
  };
}

/** The lists in the order they are stated: write first, so whoever may change it is said before anything else. */
function automationLists(statements: CreationStatements): StatedList<'automation'>[] {
  return (['write', 'read', 'fire'] as const).map((verb) => ({ verb, grantees: statements[verb] }));
}

export { automationWithNoPerson, connectionWithNoPerson, automationLists, firedTodayBy, type ListenReach };
