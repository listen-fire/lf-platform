// The handbook chapter `linkedin_research` declares on its manifest —
// assembled into the automation book as `plugin:linkedin_research`.
//
// Kept in its own module so the prose imports nothing: the plugin's own
// module pulls in the search, fetch and model chain, and the handbook must not.

import type { HandbookSection } from 'movement-engine/public/handbook';

export const LINKEDIN_RESEARCH_HANDBOOK_SECTION: HandbookSection = {
  title: 'LinkedIn activity — what a person is up to',
  content: `## LinkedIn activity — what a person is up to

\`linkedinResearch\` takes a person's LinkedIn address and works out what they are currently doing — the role and organisation their profile shows, plus recent public activity found on the web — then writes it up in a paragraph you can read.

### the-shape

\`\`\`
import { linkedinResearch } from plugins

node Person: "each person named in this message" {
  name:     <text> "the person's name"
  linkedin: <text> "their LinkedIn address, if the message has one"
  about:    <text> "what the message says about them"
}

map(extract(content, Person), (p) => {
  activity = linkedinResearch(p.linkedin, { context: p.about })
  write crm-[:People]-> {
    unique by (FUZZY Name)
    Name:          p.name
    Description ?: activity.activity_summary
  }
})
\`\`\`

It runs once per person, inside the \`map\`, researching that person's own address. A person whose \`linkedin\` came back empty is skipped — no research, no error.

\`context\` is optional: text you already hold about the person, such as the message that mentioned them. It helps the search tell this person from a namesake and is never evidence alone. A claim needs a page found on the web to rest on, whatever \`context\` says.

### what-comes-back

A record, every field of which may be absent:

- \`activity_summary\` — the write-up: current role and organisation, what they appear to be doing now, recent activity with dates where known, and a plain hedge where the public record ends. Each claim carries a bracketed number pointing at the address it rests on.
- \`activity_confidence\` — \`high\`, \`medium\` or \`low\`. Read it before trusting the summary. \`high\` means the profile and two independent recent sources agree; \`medium\`, the profile plus one recent source, or several with nothing dated inside about a year; \`low\`, the profile alone, or sources that fit but say little.
- \`current_role\` and \`current_organisation\` — as the research read them.
- \`activity_sources\` — one address per line, numbered to match the summary's citations.
- \`activity_text\` — the passages found that name the person and something tying them to this identity, each under its source address. It can arrive on its own, with no \`activity_summary\` and no \`activity_confidence\`: text with no summary means nothing beyond that text was confirmed, so read it as raw material, not as a finding.

### when-there-is-nothing-to-find

A result counts as this person's only when it is consistent with their own profile — the organisation or the field. A location alone never ties anyone down. A namesake's news is left out rather than folded in, so a common name with a sparse profile produces a low-confidence answer instead of somebody else's story.

When nothing survives that test, every field is absent: no public signal. Short of that, passages can arrive at low confidence with no summary: only \`activity_text\` comes back, and it means nothing beyond that text was confirmed.

### Common mistakes

- **Expecting it to find a person from a name.** It starts from an address and never searches for one. To turn a name into a profile address, call \`research\` and read its \`linkedin\`, then pass that here.
`,
  engineClaims: [
    {
      construct: 'linkedinResearch called per person inside map, its write-up filled into a record',
      status: 'runs',
      probe: `
import { linkedinResearch } from plugins

inbox = connect \`@lf/email\`
crm   = connect \`@lf/attio\` using acme

node Person: "each person named in this message" {
  name:     <text> "the person's name"
  linkedin: <text> "their LinkedIn address, if the message has one"
  about:    <text> "what the message says about them"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  map(extract([m.Body], Person), (p) => {
    activity = linkedinResearch(p.linkedin, { context: p.about })
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:          p.name
      Description ?: activity.activity_summary
    }
  })
}
`,
    },
  ],
};
