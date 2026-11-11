// Whether an automation's language version pin is one this release only
// carries: its arrivals are read and judged by that version's own modules and
// rules, which never vouch for who acted, so the platform's door cannot apply a
// fire list to them. Upgrading the automation moves it onto the current core.

import { isLegacyLanguageVersion } from 'legacy-lang';
import { currentVersion, versionOf, versionOfLegacyId } from '@listen-fire/language-versions';

import { StatementStore } from './statement';

/** A pin whose version this build carries but is not the current one; a legacy id counts, as the version it ran beside. */
function pinIsCarried(pin: string): boolean {
  const version = isLegacyLanguageVersion(pin) ? versionOfLegacyId(pin) : versionOf(pin);
  return version !== undefined && version !== currentVersion();
}

/** Whether the automation is pinned to a carried version now; false when there is no such automation. */
async function onCarriedPin(automationId: string): Promise<boolean> {
  const pin = await StatementStore.languagePinOf({ thing: 'automation', id: automationId });
  return pin !== undefined && pinIsCarried(pin);
}

export { pinIsCarried, onCarriedPin };
