// Manual's authoring documentation is the language handbook's own
// `system:manual` chapter (`UNIT_CHAPTERS`), so the platform serves the text the
// language checks; the platform adds only the probe its engine-claims check runs.

import { UNIT_CHAPTERS } from '@listen-fire/handbook';
import type { HandbookSection } from '@listen-fire/engine/public/handbook';

const CHAPTER = UNIT_CHAPTERS['system:manual'];

export const MANUAL_HANDBOOK_SECTION: HandbookSection = {
  title: CHAPTER.title,
  content: CHAPTER.content,
  engineClaims: [
    {
      construct: 'manual-channel backfills (instance-rooted traversal in the body)',
      status: 'runs',
      probe: `
crm = connect \`@lf/attio\` using acme

function \`Nightly Backfill\`(go: <manual-[:Invocations]->>) {
  crm-[c:Companies]-> {
    write c { Categories: "Reviewed" }
  }
}

listen to manual-[:Invocations]-> fire \`Nightly Backfill\`
`,
    },
    {
      construct: 'manual runs carrying text + files (reading the invocation text and extracting from the supplied files)',
      status: 'runs',
      probe: `
crm = connect \`@lf/attio\` using acme

node Company: "each company named in the supplied text or files" {
  name:   <text> "the company's name"
  domain: <text> "the company's web domain, if given"
}

function \`Import Companies\`(go: <manual-[:Invocations]->>) {
  found = extract([go.Text, ...go-[:Files]->.File], Company)

  map(found, (c) => {
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:    c.name
      Domains: c.domain
    }
  })
}

listen to manual-[:Invocations]-> fire \`Import Companies\`
`,
    },
  ],
};
