// The default-'5' story fixtures of legacy-lang's story/__test__/story.unit.test.ts,
// copied for the story parity corpus, with a snapshot equal to their catalog.
import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

const mailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        body: 'text',
        subject: 'text',
        action: { kind: 'enum', options: ['message.received', 'message.sent'] },
      },
      edges: {},
    },
  },
  collections: {},
  writableRoots: {},
  eventPositions: [{ position: 'message', on: ['message.received', 'message.sent'] }],
};

const crmSchema: InstanceSchema = {
  positions: {
    Companies: {
      properties: { Name: 'text' },
      edges: {
        Deals: { target: 'Deals', writable: true },
        Owner: { target: 'People', writable: true },
      },
    },
    Deals: { properties: { Title: 'text', Stage: 'text' }, edges: {} },
    People: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { Companies: { target: 'Companies' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Companies: {
      fields: { Name: 'text' },
      resultShape: { externalId: 'text' },
      edges: {
        Deals: { target: 'Deals', writable: true },
        Owner: { target: 'People', writable: true },
      },
    },
    Deals: { fields: { Title: 'text', Summary: 'text', Stage: 'text' }, resultShape: {} },
    People: { fields: { Name: 'text' }, resultShape: {} },
  },
};

const askSchema: InstanceSchema = {
  positions: {
    response: { properties: { answer: 'boolean' }, edges: {} },
  },
  collections: { Check: { target: 'Check' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Check: {
      fields: { prompt: 'text' },
      resultShape: { externalId: 'text', state: 'text' },
      edges: { Response: { target: 'response', awaitable: true, watchable: true, resolvesEmpty: true } },
    },
  },
};

export const LEGACY_STORY_SNAPSHOT = mockCatalogSnapshot({
  adapters: {
    mail: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['key', 'events'],
      triggerConfigOptions: { events: ['message.received', 'message.sent'] },
      schema: mailSchema,
    },
    crm_sys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
    asksys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: askSchema,
    },
  },
  credentials: {
    inbox_creds: { adapter: 'mail' },
    crm_creds: { adapter: 'crm_sys' },
    ask_creds: { adapter: 'asksys' },
  },
});

export const SOURCE = `import { mail, crm_sys, asksys } from adapters
import { inbox_creds, crm_creds, ask_creds } from credentials

inbox = connect mail using inbox_creds
book = connect crm_sys using crm_creds
questions = connect asksys using ask_creds

function note_owner(co: <book-[:Companies]->>) {
  seen = co.\`Name\`
}

function intake(m: <inbox-[:message]->>) {
  facts = extract from [m.\`body\`] {
    name: <text> "the person's name"
    amount: <number> "the deal size"
    node company: "the company they are from" {
      domain: <text> "the web domain"
      node colleague: "everyone else named at that company" {
        name: <text> "their full name"
      }
    }
  }
  c = write book-[:Companies]-> { unique by (\`Name\`) Name ?: facts.name }
  d = write c-[:Deals]-> { Title: "Deal — \${facts.name}", Summary: ai("summarise the thread") }
  lead = match c-[:Owner]-> { unique by (\`Name\`) Name: "sam" }
  if (lead != null) {
    link c -[:Owner]-> lead
  }
  a = write questions-[:Check]-> { prompt: "approve this deal?" }
  answer = await first(a-[:Response]->)
  amount = coalesce(facts.amount, 0)
  timing = race(() => { await sleep(2d) }, () => { return true })
  if (amount > 1000) {
    write d { Stage: "big" }
  } else {
    write d { Stage: "small" }
  }
  note_owner(c)
}

listen to inbox { key: "dealflow", events: ["message.received"] } fire intake
`;

export const TRAVERSALS = `import { mail, crm_sys, asksys } from adapters
import { inbox_creds, crm_creds, ask_creds } from credentials

inbox = connect mail using inbox_creds
book = connect crm_sys using crm_creds
questions = connect asksys using ask_creds

function flows(m: <inbox-[:message]->>) {
  a = write questions-[:Check]-> { prompt: "approve this deal?" }

  book-[one:Companies WHERE one.\`Name\` == "acme"]-> {
    write one { Name: "acme" }
  }

  book-[two:Companies WHERE two.\`Name\` == "acme" AND two.\`Name\` != "other"]-> {
    seen_two = two.\`Name\`
  }

  book-[three:Companies WHERE three.\`Name\` == "acme" OR three.\`Name\` == "other"]-> {
    seen_three = three.\`Name\`
  }

  book-[co:Companies]->-[deal:Deals]-> {
    seen_deal = deal.\`Title\`
  }

  a-[reply:Response]-> {
    seen_reply = reply.answer
  }

  outcome = race(() => { return await first(a-[:Response]->) }, () => { await sleep(1d) })
}

listen to inbox { key: "flows" } fire flows
`;

export const CALLBACK_SOURCE = `import { crm_sys } from adapters
import { crm_creds } from credentials

book = connect crm_sys using crm_creds

function approve() {
  co = only(book-[c:Companies WHERE c.\`Name\` == "Acme"]->)
  yes = callback({ write book-[:Companies]-> { Name: "approved" } })
  no = callback({ write book-[:Companies]-> { Name: "declined" } })
  write book-[:Companies]-> { Name: "asked \${yes.id} \${no.id}" }
  r = race(
    () => { await first(yes-[:Called]->) },
    () => { await first(no-[:Called]->) },
    () => { await sleep(1d) },
  )
  if (r[2] == null) {
    write book-[:Companies]-> { Name: "nobody answered" }
  }
}
`;

const ASSEMBLED = `movement take(lead: <Lead>) {
  seen = lead.Name
}

node Lead {
  Name: <text>
  Source: <text>
}

movement build() {
  l = node { Name: "Acme", Source: "inbound" }
  take(lead: l)
  take(lead: node { Name: "Other", Source: "outbound" })
}
`;

export const LEGACY_STORY_SOURCES: Record<string, string> = {
  deal_intake: SOURCE,
  deal_intake_with_broken_movement: `${SOURCE}\nmovement broken(m: <inbox-[:message]->>) { write book-[:Nope]-> { Name: "x" } }`,
  deal_intake_nullable_domain: SOURCE.replace('domain: <text> "the web domain"', 'domain: <text | null> "the web domain"'),
  guarded_error_arm: `import { mail, crm_sys } from adapters
import { inbox_creds, crm_creds } from credentials

inbox = mail(credentials: inbox_creds)
book = crm_sys(credentials: crm_creds)

movement guarded(m: <inbox-[:message]->>) {
  if m.\`subject\` == "bad" {
    ERROR("rejected")
  } else {
    write book-[:Companies]-> { Name: "ok" }
  }
}
`,
  value_walk: SOURCE.replace(
    '  a = write questions-[:Check]->',
    '  owner = c-[:Owner]->.Name\n  a = write questions-[:Check]->',
  ),
  expression_whole_pick: SOURCE.replace(
    '  a = write questions-[:Check]->',
    '  pick = IF facts.amount > 1 THEN facts.name ELSE "none" END\n  a = write questions-[:Check]->',
  ),
  unresolvable_name: `movement solo() {
  x = "\${nobody.here}"
}
`,
  assembled: ASSEMBLED,
  pass_through_traversal: `${SOURCE.replace(
    'note_owner(c)',
    'file(node { Label: "x", company: facts-[c:company]-> })',
  )}
node Filing {
  Label: <text>
  node company {
    domain: <text>
  }
}

function file(shape: <Filing>) {
  seen = shape.Label
}
`,
  traversals: TRAVERSALS,
  unreadable_head: `import { mail } from adapters
import { inbox_creds } from credentials

inbox = mail(credentials: inbox_creds)

movement broken(m: <inbox-[:message]->>) {
  nowhere-[x:Nothing]-> {
    seen = m.\`body\`
  }
}
`,
  callback: CALLBACK_SOURCE,
  callback_body_less: CALLBACK_SOURCE.replace(
    'yes = callback({ write book-[:Companies]-> { Name: "approved" } })',
    'yes = callback()',
  ),
  fold_over_literal: CALLBACK_SOURCE.replace(
    'only(book-[c:Companies WHERE c.\`Name\` == "Acme"]->)',
    'only([1, 2])',
  ),
  extended_node_shape: [
    'node Entry {',
    '  name: <text>',
    '  node founder { first: <text> } order by arrival',
    '}',
    'node `Recap Entry` extends Entry { diverse_founder: <text | null> }',
  ].join('\n'),
};
