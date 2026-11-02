// Cron's conceptual authoring documentation — assembled into the automation
// handbook as the `system:cron` chapter, bound by the same prose contract as
// every hand-written chapter.

import type { HandbookSection } from 'movement-engine/public/handbook';

export const CRON_HANDBOOK_SECTION: HandbookSection = {
  title: 'Schedules — time-triggered runs (cron)',
  content: `## Schedules — time-triggered runs (cron)

Listen to \`cron\`'s \`Ticks\` to run an automation on a schedule. It is the host's own — no import, no \`connect\`:

\`\`\`
function \`Weekly Digest\`(t: <cron-[:Ticks]->>) { … }

listen as "Weekly digest" to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1"]-> fire \`Weekly Digest\`
\`\`\`

- \`Schedule\` (required): five-field cron — \`"0 9 * * 1"\` is 09:00 every Monday. UTC by default; add \`AND t.Zone == "Europe/London"\` (an IANA name, daylight-saving aware) for wall-clock time. \`IN [...]\` names several.
- A \`Tick\` carries \`Fired at\`, \`Schedule\` and \`Zone\`.
- Occurrences missed while the platform was down collapse into one tick — a digest that missed three Mondays sends one. A newly saved schedule waits for its next occurrence; it never fires retroactively.`,
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
