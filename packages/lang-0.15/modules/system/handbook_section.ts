// The system adapter's conceptual authoring documentation — assembled into the
// automation handbook as the `system:system` chapter, bound by the same prose
// contract as every hand-written chapter.

import type { HandbookSection } from '@listen-fire/engine/public/handbook';

const REPORT_FAILURES = `
sys  = connect \`@lf/system\`
team = connect \`@lf/slack\` using team_workspace

function report(e: <sys-[:Events]->>) {
  alerts = only(team-[ch:Channels WHERE ch.Name == "alerts"]->)
  if (alerts == null) { fail("no #alerts channel") }
  write alerts-[:Messages]-> { Message: "\${e.Automation} failed: \${e.Reason} \${e.Url}" }
}

listen to sys-[e:Events WHERE e.Kind == "Run Failed"]-> fire report
`;

export const SYSTEM_HANDBOOK_SECTION: HandbookSection = {
  title: 'Platform events — when an automation fails (system)',
  content: `## Platform events — when an automation fails (system)

Connect \`@lf/system\` to run an automation when something happens to your other automations. Post each failure to Slack:

\`\`\`${REPORT_FAILURES}\`\`\`

- Every event arrives on \`Events\`. Name the kinds a listen wants with \`e.Kind == "…"\` or \`e.Kind IN [...]\`: \`Run Failed\`, \`Run Paused\`, \`Wait Lost Its Record\`, \`Arrival Not Judged\`, \`Release Applied\`, \`Validation Issue\`, \`Deprecated Version\`.
- Every event carries \`Kind\`, \`Event Id\`, \`Automation\`, \`Automation Id\`, \`Run Id\`, \`Version\`, \`Reason\`, \`Url\` and \`At\`. A wait that lost its record also carries \`Adapter\`, \`Edge\` and \`Record Id\`; an arrival not judged carries \`Edge\`, \`Record Id\`, \`Listen\`, \`Delivery Id\`, \`Arrival Id\` and \`Attempt\`.
- \`Run Failed\` arrives within a couple of minutes of a run ending failed, once per run. \`Url\` links to the automation's failed runs. A rehearsal failing is not reported.
- \`Run Paused\` arrives when a run reaches the deployment's cost limit and pauses instead of failing. \`Reason\` says what it spent and the limit. The run waits until someone resumes it, which resets its usage.
- \`Wait Lost Its Record\`: a run waits on a record that was deleted, so nothing will arrive. Race such a wait with a \`sleep\`.
- \`Arrival Not Judged\`: a listen could not tell whether something that arrived fires it, because its WHERE reads a field the connected system could not give. That listen ran nothing; the arrival's other listens ran.
- \`Validation Issue\`, \`Deprecated Version\` and \`Release Applied\` arrive when a new release is deployed.
- An automation is never told about its own listen's failures or waits. A handler that fails on another automation's failures, which fails in turn, is a chain the platform pauses.
- Going live never replays earlier events: the first look sets the mark.`,
  engineClaims: [
    {
      construct: 'system-channel listeners (runs over the Events edge, narrowed by Kind)',
      status: 'runs',
      probe: REPORT_FAILURES,
    },
  ],
};
