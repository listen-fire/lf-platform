/**
 * One-off provisioner for the runtime-contestant race e2e (layer 13 C3): the
 * CRM's companies become the options of ONE question, and the answer names the
 * winner — raced against a 2d timeout. The winner's name lands in a Telegram
 * reply. Drive it with:
 *
 *   pnpm dev:inject telegram-event --text "go"
 *   # grab the question's Url from the reply (dev:inspect telegram outbox)
 *   pnpm dev:inject telegram-callback --token <ask_…> --answer "<company name>"
 *   # the settled run replies "won=<name>"
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

async function ensureCredential(input: {
  teamId: string;
  type: ExternalServiceType;
  name: string;
  secret: Record<string, string>;
}): Promise<void> {
  const existing = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId as TeamId)
    .where('type', '=', input.type)
    .select('id')
    .executeTakeFirst();
  if (existing) return;
  await persistCredential({
    teamId: input.teamId as TeamId,
    userId: null,
    name: input.name,
    type: input.type,
    credentials: input.secret,
    use: connectionWithNoPerson().use,
  });
}

const MOVEMENT = `

tg = connect \`@lf/telegram\` using \`Dev Loop Telegram\`
questions = connect \`@lf/ask\`
crm = connect \`@lf/attio\` using \`Dev Loop Attio\`

function race_fanout_probe(m: <tg-[:\`Message\`]->>) {
  names = crm-[c:Companies]-> {
    return c.\`Name\`
  }
  q = write questions-[:Choose]-> {
    Prompt: "Which company?"
    Options: names
  }
  write m-[:Replies]-> {
    Text: "pick one of \${count(names)}: \${q.Url}"
  }

  w = race(
    () => {
      a = await first(q-[:Response]->)
      return a.Answer
    },
    () => { await sleep(2d) },
  )

  write m-[:Replies]-> {
    Text: "won=\${coalesce(w[0], "timeout")}"
  }
}

listen to tg-[:Messages]-> fire race_fanout_probe
`;

async function main() {
  const seed = await ensureDevLoopTeam();
  await ensureCredential({
    teamId: seed.teamId,
    type: ExternalServiceType.TELEGRAM,
    name: 'Dev Loop Telegram',
    secret: { botToken: 'dev-loop-telegram-token' },
  });

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
