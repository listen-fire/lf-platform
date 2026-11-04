// The ask service's safety sweep. An answer and a cancel each deliver the
// ask's `Response` arrival at their own door (in_process_notifier.ts); this
// periodic row covers a delivery lost on the way (a crash between the ask's
// write and the delivery's). It delivers each ask settled within the window
// again: a delivery is named by the ask's state and id, so one kept before
// keeps nothing and wakes nothing twice.

import type { WorkHandler } from '../work/kinds';
import type { AskId } from '../../generated/kysely/asks/Ask';

import { SECOND } from '../../constants';
import { getAsksQb } from '../../lib/kysely';
import { registerWorkKinds, type WorkKindRegistration } from '../work/drain';
import { teamIdSchema } from '../../lib/team_id';
import { loadClosedAskAwaitPage } from './carried_ask_awaits';
import { deliverSettle, wakeRunsParkedOnAsk } from './in_process_notifier';
import { getAsk } from './store';

/** How far back a settle is delivered again: well past any crash's restart. */
const SETTLED_WITHIN_MS = 60 * 60 * SECOND;
const PAGE_SIZE = 500;

export const askClosedSweepHandler: WorkHandler = {
  async run(_payload, ctx) {
    const since = new Date(ctx.now.getTime() - SETTLED_WITHIN_MS);
    let after: AskId | undefined;
    for (;;) {
      let page = getAsksQb(['ask'])
        .selectFrom('ask')
        .where('state', '!=', 'open')
        .where('updated_at', '>=', since)
        .select('id')
        .orderBy('id')
        .limit(PAGE_SIZE);
      if (after !== undefined) page = page.where('id', '>', after);
      const rows = await page.execute();
      for (const { id } of rows) {
        const ask = await getAsk(id);
        if (ask !== null) await deliverSettle(ask);
      }
      if (rows.length < PAGE_SIZE) break;
      after = rows[rows.length - 1]?.id;
    }
    // A run parked on an ask under 0.12, however long ago its ask closed: the
    // correlation row says it has not been woken yet.
    let correlated: string | undefined;
    do {
      const page = await loadClosedAskAwaitPage({ limit: PAGE_SIZE, ...(correlated !== undefined ? { after: correlated } : {}) });
      for (const { teamId, askId } of page.wakes) await wakeRunsParkedOnAsk({ id: askId, teamId: teamIdSchema.parse(teamId) });
      correlated = page.next;
    } while (correlated !== undefined);
  },
};

// The ask unit's own periodic kind.

declare module '../work/kinds' {
  interface UnitWorkKinds {
    ask_closed_sweep: true;
  }
}

export const ASK_WORK_KINDS: readonly WorkKindRegistration[] = [
  { kind: 'ask_closed_sweep', handler: askClosedSweepHandler, intervalMs: 30 * SECOND },
];

export function registerAskClosedSweepWork(): void {
  registerWorkKinds(ASK_WORK_KINDS);
}
