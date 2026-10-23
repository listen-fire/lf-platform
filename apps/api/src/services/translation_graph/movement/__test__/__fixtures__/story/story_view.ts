// The story view's fixture program and its two systems, shared by the story
// view's tests and the story parity corpus.

import { mockCatalog, mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

/** The trigger side, plus the pause: a desk whose Query root awaits a Reply. */
const deskSchema: InstanceSchema = {
  positions: {
    note: { properties: { text: 'text' }, edges: {} },
    reply: { properties: { answer: 'boolean' }, edges: {} },
  },
  collections: { Query: { target: 'Query' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Query: {
      fields: { prompt: 'text' },
      resultShape: { externalId: 'text' },
      edges: { Reply: { target: 'reply', awaitable: true, watchable: true, resolvesEmpty: true } },
    },
  },
  eventPositions: [{ position: 'note', on: ['note.filed'] }],
};

/** The write side: a two-record graph with a parent edge. */
const ledgerSchema: InstanceSchema = {
  positions: {
    Orgs: { properties: { Title: 'text' }, edges: { Entries: { target: 'Entries', writable: true } } },
    Entries: { properties: { Amount: 'number' }, edges: {} },
  },
  collections: { Orgs: { target: 'Orgs' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Orgs: {
      fields: { Title: 'text' },
      resultShape: { externalId: 'text' },
      edges: { Entries: { target: 'Entries', writable: true } },
    },
    Entries: { fields: { Amount: 'number', Stage: 'text' }, resultShape: {} },
  },
};

const catalogSpec: Parameters<typeof mockCatalog>[0] = {
  adapters: {
    desk_sys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['box', 'events'],
      triggerConfigOptions: { events: ['note.filed'] },
      schema: deskSchema,
    },
    ledger_sys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: ledgerSchema,
    },
  },
  credentials: { desk_creds: { adapter: 'desk_sys' }, ledger_creds: { adapter: 'ledger_sys' } },
};

export const STORY_VIEW_CATALOG = mockCatalog(catalogSpec);
export const STORY_VIEW_SNAPSHOT = mockCatalogSnapshot(catalogSpec);

export const STORY_VIEW_SOURCE = `import { desk_sys, ledger_sys } from adapters
import { desk_creds, ledger_creds } from credentials

desk = connect desk_sys using desk_creds
books = connect ledger_sys using ledger_creds

function intake(n: <desk-[:note]->>) {
  facts = extractOne([n.\`text\`], node Facts: "what the note says" {
    who: <text> "who filed it"
    node vendor: "the supplier it mentions" {
      title: <text> "the supplier's name"
      node contact: "anyone named at the supplier" {
        email: <text> "their email address"
      }
    }
  })
  org = write books-[:Orgs]-> { unique by (\`Title\`) Title: n.\`text\` }
  entry = write org-[:Entries]-> { Amount: 12 }
  books-[shop:Orgs WHERE shop.\`Title\` == "acme"]-> {
    seen = shop.\`Title\`
  }
  org-[line:Entries]-> {
    seen_line = line.\`Amount\`
  }
  q = write desk-[:Query]-> { prompt: "approve this?" }
  ok = await first(q-[:Reply]->)
  if (ok) {
    write entry { Stage: "settled" }
  }
  await sleep(2d)
}

listen to desk { box: "inbound", events: ["note.filed"] } fire intake
`;
