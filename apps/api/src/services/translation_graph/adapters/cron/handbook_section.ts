// Cron's authoring documentation is the language handbook's own
// `system:cron` chapter (`UNIT_CHAPTERS`), so the platform serves the text the
// language checks; the platform adds only the probe its engine-claims check runs.

import { UNIT_CHAPTERS } from '@listen-fire/handbook';
import type { HandbookSection } from 'movement-engine/public/handbook';

const CHAPTER = UNIT_CHAPTERS['system:cron'];

export const CRON_HANDBOOK_SECTION: HandbookSection = {
  title: CHAPTER.title,
  content: CHAPTER.content,
  engineClaims: [
    {
      construct: 'cron-channel listeners (scheduled movements over the Tick position)',
      status: 'runs',
      probe: `
team  = connect \`@lf/slack\` using team_workspace

function \`Weekly Digest\`(t: <cron-[:Ticks]->>) {
  updates = only(team-[ch:Channels WHERE ch.Name == "updates"]->)
  if (updates == null) { fail("no #updates channel") }
  write updates-[:Messages]-> { Message: "Digest for \${t.\`Fired at\`}" }
}

listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1"]-> fire \`Weekly Digest\`
`,
    },
  ],
};
