/**
 * Second one-off verification provisioner: the SHARED BUILT-IN bot path for
 * the Telegram ask-button round-trip. Uses a connected-EMPTY TELEGRAM
 * credential (Chunk 7's "connect the shared bot" gesture) so both the send
 * and the callback ack/clear resolve through TELEGRAM_BOT_TOKEN, matching
 * the shared /api/public/telegram/builtin door used by
 * `pnpm dev:inject telegram-callback` (no --byo).
 *
 * The in-chat `callback_data` tap it used to provision carried the ask's
 * `Token`, retired with callback-primitive layer 3; the keyboard is the `url`
 * form until layer 4 re-points the tap at a callback id.
 */
import './_profile_loader';
import '../../services';
import { ensureDevLoopTeam } from './_lib';
import { getAutomationsQb } from '../../lib/kysely';
import { persistCredential } from '../../services/credentials/persist_credential';
import { connectionWithNoPerson } from '../../services/access/no_person';

import type { TeamId } from '../../generated/kysely/core/Team';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';


import { saveMovement } from '../../services/translation_graph/movement/provision';

async function ensureEmptyCredential(input: { teamId: string; name: string }): Promise<void> {
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId as TeamId)
    .where('type', '=', ExternalServiceType.TELEGRAM)
    .where('name', '=', input.name)
    .select('id')
    .executeTakeFirst();
  if (existing) return;
  await persistCredential({
    teamId: input.teamId as TeamId,
    userId: null,
    name: input.name,
    type: ExternalServiceType.TELEGRAM,
    credentials: {},
    use: connectionWithNoPerson().use,
  });
}

const MOVEMENT = `

tg = connect \`@lf/telegram\` using \`Dev Loop Telegram Builtin\`
questions = connect \`@lf/ask\`

function tg_ask_buttons_builtin(m: <tg-[:\`Message\`]->>) {
  q = write questions-[:Check]-> {
    Prompt: "Send the update? (builtin)"
    Detail: "\${m.\`Text\`}"
  }

  write m-[:Replies]-> {
    Text: "Send the update (builtin)? \${q.Url}"
    \`Reply Markup\`: {
      inline_keyboard: [
        [ { text: "Approve", url: "\${q.Url}?answer=true" },
          { text: "Open", url: "\${q.Url}?answer=true" } ]
      ]
    }
  }

  answer = await first(q-[:Response]->)
  if (answer.Answer) {
    write m-[:Replies]-> { Text: "Approved (builtin)." }
  }
}

listen to tg-[:Messages]-> fire tg_ask_buttons_builtin
`;

async function main() {
  const seed = await ensureDevLoopTeam();
  await ensureEmptyCredential({ teamId: seed.teamId, name: 'Dev Loop Telegram Builtin' });

  const result = await saveMovement({ audience: { for: 'run' }, teamId: seed.teamId, source: MOVEMENT });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
