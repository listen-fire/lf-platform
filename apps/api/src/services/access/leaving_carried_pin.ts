// What an automation's fire list becomes when an upgrade moves it off a
// carried pin. While the pin was carried its fire list said anyone because the
// pin forced it, never because someone chose it, and Slack's door kept
// strangers out meanwhile (`router.ts`). On the current pin the fire list is
// the only check, so the upgrade restates it as a current automation with no
// person deciding would get it (`no_person.ts`, as the backfill does), from the
// upgraded file's listens. A list without anyone was chosen (only an import
// can bring one), and is kept: an upgrade never widens who may fire.

import type { LanguageVersion } from 'movement-lang';
import { neverAsAny } from 'movement-engine/public/types';

import { isLfEngineTeam } from '../lf_engine/team_engine';
import { listenReachesOf } from '../translation_graph/movement/save_access';
import { pinIsCarried } from './carried_pin';
import { automationWithNoPerson, type ListenReach } from './no_person';
import { StatementStore, type Grantee, type Target } from './statement';

/** Who may fire it once it has moved, and why. */
type FireOnLeaving =
  | { kind: 'restated'; grantees: readonly Grantee[]; runsOnLf: boolean }
  | { kind: 'kept' };

type Leaving = { teamId: string; id: string; from: string; source: string; to: LanguageVersion };

function listensOf(source: string, to: LanguageVersion): ListenReach[] {
  try {
    return listenReachesOf(source, { languageVersion: to });
  } catch {
    // A text that does not parse has no listens to read, and the narrowest list follows from none.
    return [];
  }
}

/**
 * What moving `leaving` off its pin does to its fire list, or undefined when
 * its pin is not carried, whose fire list someone chose. An automation with
 * nothing stated yet is restated too: the backfill gives it the same list
 * once it is on the current pin.
 */
async function fireOnLeaving(leaving: Leaving): Promise<FireOnLeaving | undefined> {
  if (!pinIsCarried(leaving.from)) return undefined;
  const now = await StatementStore.grantsOf({ thing: 'automation', id: leaving.id }, { teamId: leaving.teamId, verb: 'fire' });
  if (now.length > 0 && !now.some((grantee) => grantee.kind === 'anyone')) return { kind: 'kept' };
  const runsOnLf = await isLfEngineTeam(leaving.teamId);
  const { fire } = automationWithNoPerson({ listens: listensOf(leaving.source, leaving.to), runsOnLf, carriedPin: false });
  return { kind: 'restated', grantees: fire, runsOnLf };
}

/**
 * Restate the fire list of an automation moving off a carried pin, inside the
 * transaction that moves it. One with nothing stated is left for the backfill,
 * which states all its lists together.
 */
async function restateFireOnLeaving(leaving: Leaving): Promise<void> {
  const fire = await fireOnLeaving(leaving);
  if (fire?.kind !== 'restated') return;
  const target: Target<'automation'> = { thing: 'automation', id: leaving.id };
  if (!(await StatementStore.hasAnyStatement(target))) return;
  await StatementStore.replaceGrants(target, { teamId: leaving.teamId, verb: 'fire', grantees: fire.grantees });
}

/** The one sentence an upgrade's answer says about who may fire it once moved. */
function fireSentence(fire: FireOnLeaving, versions: { from: string; to: LanguageVersion }): string {
  switch (fire.kind) {
    case 'kept':
      return 'Who may set it off through its listens stays as its fire list says, now checked at the door; setAccess changes who may.';
    case 'restated': {
      if (fire.runsOnLf) {
        return "Anyone who reaches its listens may still set it off, since this team runs on lf, whose own filters decide; setAccess changes who may once the team is back on the platform's engine.";
      }
      const anyone = fire.grantees.some((grantee) => grantee.kind === 'anyone');
      return anyone
        ? `Anyone who reaches its listens may set it off, as on ${versions.from}; setAccess changes who may.`
        : `Only the team's members may set it off through its listens on ${versions.to}, as its listens admitted them on ${versions.from}; setAccess changes who may.`;
    }
    default:
      return neverAsAny(fire);
  }
}

export { fireOnLeaving, restateFireOnLeaving, fireSentence, type FireOnLeaving };
