// The platform's report of an Affinity write the caller walked past: the ops
// Slack alert the client and the extraction pipeline sent before Affinity
// became a module, with the same text. Installed on import.

import { reportAffinityWriteFailuresTo } from '@listen-fire/affinity/write_failures';
import { currentContext } from '../../../context';
import { sendSlackNotification } from '../../../../lib/slack';

reportAffinityWriteFailuresTo(async ({ kind, detail }) => {
  switch (kind) {
    case 'note': {
      const ctx = currentContext();
      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:warning: Affinity error for user ${ctx.user.id} adding note (${detail})`,
        opsTitle: `Affinity error adding a note`,
      });
      return;
    }
    case 'field value':
      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:warning: Affinity error adding field value (${detail})`,
        opsTitle: 'Affinity error adding a field value',
      });
      return;
    case 'domain':
      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:warning: Affinity refused an organisation's domain, written without it (${detail})`,
        opsTitle: 'Affinity refused an organisation domain',
      });
      return;
    default: {
      // The type check catches a new kind at the next bump; until then a newer
      // module still alerts, because throwing here would fail the write the
      // module chose to walk past.
      const unknownKind: never = kind;
      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:warning: Affinity refused a ${String(unknownKind)} write (${detail})`,
        opsTitle: 'Affinity refused a write',
      });
      return;
    }
  }
});
