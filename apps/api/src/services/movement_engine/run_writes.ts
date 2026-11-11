// What the platform keeps of each record write a run sends, the moment its
// module answers it, whichever release runs it: this release's adapters reach
// it through the loop breaker's `ledgeredAdapters`, a carried version's run
// host through `keepWrite`.
//
//   - Every write goes into the loop breaker's ledger (`writeKeeper`).
//   - A question the run raises is told the run that asked it and that run's
//     automation (`recordAsker`), which is who may see it once the run is gone.

import { ASK_ADAPTER_TYPE, isAskFamily } from '@listen-fire/ask';

import type { TeamId } from '../../generated/kysely/core/Team';

import { writeKeeper } from '../inbound/loop_breaker';
import { recordAsker } from '../asks/store';
import { Whose } from '../access/whose';

/** A record write a run sent, as its module answered it. */
type KeptWrite = { adapterType: string; recordType: string; externalId: string; at: string };

type KeepWrite = (write: KeptWrite) => Promise<void>;

/**
 * Tell each question a run raises which run asked it. A write of an ask
 * family is a question raised (or one withdrawn, which already names its
 * asker); an answer is written as its family's response type, so it is not one.
 */
function askerKeeper(run: { teamId: TeamId; runId: string }): KeepWrite {
  return async (write) => {
    if (write.adapterType !== ASK_ADAPTER_TYPE || !isAskFamily(write.recordType)) return;
    const owner = await Whose.automationOfRun({ runId: run.runId, teamIds: [run.teamId] });
    await recordAsker({
      teamId: run.teamId,
      askId: write.externalId,
      runId: run.runId,
      ...(owner !== undefined && owner.automationId !== null ? { automationId: owner.automationId } : {}),
    });
  };
}

/** Everything kept of one run's writes. A write that cannot be kept fails the call that sent it. */
function runWriteKeeper(run: { teamId: TeamId; runId: string }): KeepWrite {
  const ledger = writeKeeper(run);
  const asker = askerKeeper(run);
  return async (write) => {
    await ledger(write);
    await asker(write);
  };
}

export { runWriteKeeper, type KeepWrite, type KeptWrite };
