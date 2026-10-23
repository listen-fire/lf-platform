// The story projection, over one movement that exercises every construct the
// IR has a shape for: a listen, linked + position writes with edges, an ask
// (a write to an awaitable root plus the await of its resolution), a race with
// a sleep, a branch, an extraction tree, and a call.
//
// Three DIFFERENT adapter shapes on purpose — a fixture matching one adapter's
// shape cannot tell derived from hardcoded, and adapter-blindness is the whole
// claim being tested here.

import { InstanceSchema, mockCatalog } from '../../checker/catalog';
import { parseProgram } from '../../parser/parse';
import { checkProgramWithLink } from '../../checker/check';
import { type Chip, type StoryReference, type Step, type StoryIR, storyOf } from '../story';

// ── Fixtures ──

/** The trigger side: a mailbox whose events carry a change-kind axis. */
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

/** The write side: a record graph with a parent edge and an in-place update. */
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

/** The pause side: a writable-only Check whose Response edge is awaitable. */
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

const catalog = mockCatalog({
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

const SOURCE = `import { mail, crm_sys, asksys } from adapters
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

// The same program as version 3 spells it, for the test that pins that version.
const SOURCE_V3 = `import { mail, crm_sys, asksys } from adapters
import { inbox_creds, crm_creds, ask_creds } from credentials

inbox = mail(credentials: inbox_creds)
book = crm_sys(credentials: crm_creds)
questions = asksys(credentials: ask_creds)

movement note_owner(co: <book-[:Companies]->>) {
  seen = co.\`Name\`
}

movement intake(m: <inbox-[:message]->>) {
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
  d = write c-[:Deals]-> { Title: "Deal — \${facts.name}", Summary: AI("summarise the thread") }
  lead = match c-[:Owner]-> { unique by (\`Name\`) Name: "sam" }
  if lead != null {
    link c -[:Owner]-> lead
  }
  a = write questions-[:Check]-> { prompt: "approve this deal?" }
  answer = await FIRST(a-[:Response]->)
  amount = COALESCE(facts.amount, 0)
  timing = race(() => { await sleep(2d) }, () => { return TRUE })
  if amount > 1000 {
    write d { Stage: "big" }
  } else {
    write d { Stage: "small" }
  }
  note_owner(co: c)
}

listen to inbox { key: "dealflow", events: ["message.received"] } fire intake
`;

/** The steps of the movement the trigger fires, flattened one level. */
function intakeSteps(ir: StoryIR): Step[] {
  const movement = ir.flow.find((s) => s.kind === 'movement' && s.name === 'intake');
  if (movement === undefined || movement.kind !== 'movement') throw new Error('no intake movement');
  return movement.steps;
}

function stepsOfKind<K extends Step['kind']>(steps: Step[], kind: K): Array<Extract<Step, { kind: K }>> {
  return steps.filter((s): s is Extract<Step, { kind: K }> => s.kind === kind);
}

// ── The fixture itself ──

describe('the fixture program', () => {
  it('checks without errors, so the story is of a program that would run', () => {
    // Beside the extraction keyword's retirement under 5 (its tree is still checked).
    const errors = checkProgramWithLink(parseProgram(SOURCE), catalog).diagnostics.filter(
      (d) => (d.severity ?? 'error') === 'error' && d.code !== 'MOV_EXTRACT_KEYWORD_RETIRED',
    );
    expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });
});

// ── Recording is opt-in ──

describe('recording stays off by default', () => {
  it('a plain check produces no recording at all', () => {
    expect(checkProgramWithLink(parseProgram(SOURCE), catalog).recording).toBeUndefined();
  });

  it('recordAnalysis: true produces frames, writes AND the story nodes', () => {
    const { recording } = checkProgramWithLink(parseProgram(SOURCE), catalog, {
      recordAnalysis: true,
    });
    expect(recording).toBeDefined();
    expect(recording!.writes.length).toBeGreaterThan(0);
    expect(recording!.nodes.map((n) => n.kind)).toEqual(
      expect.arrayContaining(['instance', 'listen', 'link', 'await', 'combinator', 'branch', 'extract', 'call']),
    );
  });
});

// ── The story ──

describe('a legacy pin is drawn by legacy-lang, as its own version spells the program', () => {
  it('names the instances, the trigger and the records of the whole IR', () => {
    const result = storyOf({ languageVersion: '4', source: SOURCE_V3, catalog, name: 'Deal intake' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const ir = result.story;
    expect(ir.movement.name).toBe('Deal intake');
    expect(ir.instances.map((i) => [i.name, i.adapterType])).toEqual([
      ['inbox', 'mail'],
      ['book', 'crm_sys'],
      ['questions', 'asksys'],
    ]);
    expect(ir.triggers.map((t) => [t.instance.name, t.fires, t.events])).toEqual([['inbox', 'intake', ['message.received']]]);
    expect(ir.records.map((r) => [r.binding, r.action])).toEqual(
      expect.arrayContaining([
        ['c', 'create'],
        ['lead', 'find'],
      ]),
    );
  });

  it('refuses unparseable source with a typed no-story, never a partial guess', () => {
    const result = storyOf({ languageVersion: '4', source: 'movement m( {{{{', catalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unparseable');
    expect(result.problems).toHaveLength(1);
  });

});

describe('edges — the record graph', () => {
  it('a link body projects as its two statements: the find, then the link onto what it found', () => {
    const GUARDED = 'lead = match c-[:Owner]-> { unique by (`Name`) Name: "sam" }\n  if (lead != null) {\n    link c -[:Owner]-> lead\n  }';
    const GUARDED_V3 = 'lead = match c-[:Owner]-> { unique by (`Name`) Name: "sam" }\n  if lead != null {\n    link c -[:Owner]-> lead\n  }';
    const TWO = 'lead = match c-[:Owner]-> { unique by (`Name`) Name: "sam" }\n  link c -[:Owner]-> lead';
    expect(SOURCE).toContain(GUARDED);
    const PINNED = SOURCE_V3.replace(GUARDED_V3, TWO);
    // The body form is retired since language version 4, so its projection is
    // the story of a program pinned before it.
    const project = (source: string, languageVersion?: number) => {
      const result = storyOf({ source, catalog, name: 'Deal intake', ...(languageVersion !== undefined ? { languageVersion } : {}) });
      if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
      const ir = result.story;
      const found = ir.records.filter((r) => r.action === 'find');
      expect(found).toHaveLength(1);
      const steps = intakeSteps(ir);
      const at = steps.findIndex((s) => s.kind === 'match');
      return {
        find: { binding: found[0].binding, fields: found[0].fields.Name.source, uniqueBy: found[0].uniqueBy.map((c) => c.source) },
        order: steps.slice(at, at + 2).map((s) => s.kind),
        link: ir.edges.filter((e) => e.kind === 'link' && e.to.kind === 'record' && e.to.id === found[0].id).map((e) => e.edge),
      };
    };
    const twoStatements = project(PINNED, 3);
    expect(twoStatements).toEqual({
      find: { binding: 'lead', fields: '"sam"', uniqueBy: ['`Name`'] },
      order: ['match', 'link'],
      link: ['Owner'],
    });
    expect(project(PINNED.replace(TWO, 'lead = link c -[:Owner]-> { unique by (`Name`) Name: "sam" }'), 3)).toEqual(twoStatements);
    // Unbound, with no unique by: the body's fields are its identity.
    expect(project(PINNED.replace(TWO, 'link c -[:Owner]-> { Name: "sam" }'), 3)).toEqual({
      find: { binding: undefined, fields: '"sam"', uniqueBy: ['Name'] },
      order: ['match', 'link'],
      link: ['Owner'],
    });
  });

});

describe('flow — pauses and branches are step kinds, nested in place', () => {
  it('an arm that ERRORs is `terminates: true` — projected from the checker, not re-derived', () => {
    const source = `import { mail, crm_sys } from adapters
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
`;
    const result = storyOf({ languageVersion: '4', source, catalog, name: 'Guarded' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'guarded');
    if (movement === undefined || movement.kind !== 'movement') throw new Error('no guarded movement');
    const branches = stepsOfKind(movement.steps, 'branch');
    expect(branches).toHaveLength(1);
    expect(branches[0]!.arms[0]!.terminates).toBe(true);
    expect(branches[0]!.otherwise!.terminates).toBe(false);
  });

  it('an arm that RETURNS is `terminates: true` from version 3 — the lane does not come back', () => {
    const source = `import { mail, crm_sys } from adapters
import { inbox_creds, crm_creds } from credentials

inbox = mail(credentials: inbox_creds)
book = crm_sys(credentials: crm_creds)

movement guarded(m: <inbox-[:message]->>) {
  if m.\`subject\` == "bad" {
    return "rejected"
  }
  write book-[:Companies]-> { Name: "ok" }
  return "done"
}
`;
    const movementOf = (languageVersion: 2 | 3) => {
      const result = storyOf({ source, catalog, name: 'Guarded', languageVersion });
      if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
      const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'guarded');
      if (movement === undefined || movement.kind !== 'movement') throw new Error('no guarded movement');
      return movement;
    };
    const v3 = movementOf(3);
    expect(stepsOfKind(v3.steps, 'branch')[0]!.arms[0]!.terminates).toBe(true);
    // A `return` straight on the spine is a step, not a capped lane: the run's
    // own ending is still drawn.
    expect(v3.terminates).toBe(false);
    expect(stepsOfKind(movementOf(2).steps, 'branch')[0]!.arms[0]!.terminates).toBe(false);
  });

});

// ── Referents ──
//
// A binding name means nothing to a reader, so every reference carries what the
// name STOOD FOR. Each assertion below is about the projection knowing which
// kind of thing that is; the words ("the", "it just created") are composed
// downstream, out of labels the owning system declared.

describe('references say what they refer to', () => {
  /** The first reference part of a chip. */
  function referenceOf(chip: Chip): StoryReference {
    const part = chip.parts.find((p) => p.kind === 'reference');
    if (part?.kind !== 'reference') throw new Error(`no reference in ${chip.source}`);
    return part.reference;
  }

  it('an unresolvable name stays raw — no origin is claimed for it', () => {
    const result = storyOf({ languageVersion: '4',
      source: `movement solo() {
  x = "\${nobody.here}"
}
`,
      catalog,
    });
    if (!result.ok) throw new Error('expected a story');
    const movement = result.story.flow[0];
    if (movement?.kind !== 'movement') throw new Error('expected a movement');
    const value = movement.steps[0];
    if (value?.kind !== 'value') throw new Error('expected a value step');
    expect(referenceOf(value.value).origin).toBeUndefined();
  });
});

// ── Assembled nodes ──

describe('a node the author assembled shows its contents', () => {
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

  function build(): Step[] {
    const result = storyOf({ languageVersion: '4', source: ASSEMBLED, catalog });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'build');
    if (movement?.kind !== 'movement') throw new Error('expected the build movement');
    return movement.steps;
  }

  it('a named node carries its fields, not just the fact that it was bound', () => {
    const node = build()[0];
    if (node?.kind !== 'node') throw new Error('expected a node step');
    expect(node.binding).toBe('l');
    expect(Object.keys(node.node.fields)).toEqual(['Name', 'Source']);
    expect(node.node.fields.Name.source).toBe('"Acme"');
  });

  it('an INLINE node argument is carried too — a position argument is not nothing', () => {
    const calls = build().filter((s): s is Extract<Step, { kind: 'call' }> => s.kind === 'call');
    const inline = calls[1]?.args[0];
    if (inline?.kind !== 'node') throw new Error('expected a node argument');
    expect(inline.name).toBe('lead');
    expect(Object.keys(inline.node.fields)).toEqual(['Name', 'Source']);
  });

  // A pass-through entry is where the values come FROM, and that is a referent
  // like any other. Carrying only the path's text is what left a card saying
  // `facts-[c:company]->` — the one form the renderer could not put in words.
});

// ── Traversals ──
//
// The one authored form whose TEXT is pure syntax. Every assertion below is
// about the projection carrying STRUCTURE — hops, landings, comparisons — so a
// renderer can compose a sentence without ever seeing `-[…]->`.

const TRAVERSALS = `import { mail, crm_sys, asksys } from adapters
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

describe('traversals project as structure, never as syntax', () => {
  it('the fixture checks clean, so the structure is of a program that would run', () => {
    const errors = checkProgramWithLink(parseProgram(TRAVERSALS), catalog).diagnostics.filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it('a head that cannot be read keeps the source and claims NO hops', () => {
    const source = `import { mail } from adapters
import { inbox_creds } from credentials

inbox = mail(credentials: inbox_creds)

movement broken(m: <inbox-[:message]->>) {
  nowhere-[x:Nothing]-> {
    seen = m.\`body\`
  }
}
`;
    const result = storyOf({ languageVersion: '4', source, catalog, name: 'Broken' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'broken');
    if (movement === undefined || movement.kind !== 'movement') throw new Error('no movement');
    const [group] = stepsOfKind(movement.steps, 'group');
    expect(group!.over.from).toBeUndefined();
    expect(group!.over.hops.map((h) => h.landing)).toEqual([undefined]);
    expect(group!.over.source).toBe('nowhere-[x:Nothing]->');
  });
});

// ── Deferred actions, folds over walks, and the receipt branch ──
//
// A second program, from the shape of a real callback+race movement: two
// deferred actions raced against a timer, a message whose payload carries their
// ids by hand, a channel found with a fold over a walk, and a branch on the
// race receipt's timer slot.

const CALLBACK_SOURCE = `import { crm_sys } from adapters
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

function callbackStory(): StoryIR {
  const result = storyOf({ languageVersion: '4', source: CALLBACK_SOURCE, catalog, name: 'Approve' });
  if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
  return result.story;
}

function approveSteps(): Step[] {
  const movement = callbackStory().flow.find((s) => s.kind === 'movement' && s.name === 'approve');
  if (movement === undefined || movement.kind !== 'movement') throw new Error('no approve movement');
  return movement.steps;
}

describe('the callback fixture', () => {
  it('checks without errors, so the story is of a program that would run', () => {
    const errors = checkProgramWithLink(parseProgram(CALLBACK_SOURCE), catalog).diagnostics.filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });
});

describe('callbacks — a deferred action, with the steps that run when it is used', () => {
  it('projects a callback as its own step kind, not as a bare binding', () => {
    const [callback] = stepsOfKind(approveSteps(), 'callback');
    expect(callback).toBeDefined();
    expect(callback!.binding).toBe('yes');
    expect(callback!.movement).toBeUndefined();
  });

  it('a reference to a callback resolves to the AUTHOR’s own name for it', () => {
    const asked = callbackStory().records.find(
      (r) => r.fields.Name?.source.includes('${yes.id}') === true,
    );
    const parts = asked!.fields.Name!.parts;
    const referenced = parts.flatMap((p) =>
      p.kind === 'reference' ? [p.reference] : [],
    );
    expect(referenced.map((r) => [r.origin, r.field])).toEqual([
      [{ kind: 'callback', name: 'yes' }, 'id'],
      [{ kind: 'callback', name: 'no' }, 'id'],
    ]);
    // Two callbacks compose two different phrases, so neither is ambiguous.
    expect(referenced.every((r) => r.ambiguous === undefined)).toBe(true);
  });

  it('a body-less callback is the same shape with nothing in it', () => {
    const source = CALLBACK_SOURCE.replace(
      'yes = callback({ write book-[:Companies]-> { Name: "approved" } })',
      'yes = callback()',
    );
    const result = storyOf({ languageVersion: '4', source, catalog });
    if (!result.ok) throw new Error('expected a story');
    const movement = result.story.flow.find((s) => s.kind === 'movement');
    if (movement?.kind !== 'movement') throw new Error('no movement');
    const [callback] = stepsOfKind(movement.steps, 'callback');
    expect(callback!.steps).toEqual([]);
  });
});

describe('a fold over a walk — the call composes over the walk’s structure', () => {
  it('a fold over something with no recorded walk stays exactly as written', () => {
    const source = CALLBACK_SOURCE.replace(
      'only(book-[c:Companies WHERE c.\`Name\` == "Acme"]->)',
      'only([1, 2])',
    );
    const result = storyOf({ languageVersion: '4', source, catalog });
    if (!result.ok) throw new Error('expected a story');
    const movement = result.story.flow.find((s) => s.kind === 'movement');
    if (movement?.kind !== 'movement') throw new Error('no movement');
    const [value] = stepsOfKind(movement.steps, 'value');
    expect(value!.value.parts).toEqual([{ kind: 'text', text: 'only([1, 2])' }]);
  });
});

describe('a node declaration that extends another', () => {
  it("is shown whole — the base's fields and nested nodes first, then its own", () => {
    const source = [
      'node Entry {',
      '  name: <text>',
      '  node founder { first: <text> } order by arrival',
      '}',
      'node `Recap Entry` extends Entry { diverse_founder: <text | null> }',
    ].join('\n');
    const result = storyOf({ languageVersion: '4', source, catalog });
    if (!result.ok) throw new Error('expected a story');
    expect(result.story.shapes.find((s) => s.name === 'Recap Entry')).toEqual({
      name: 'Recap Entry',
      position: 'Recap Entry',
      fields: [{ name: 'name', type: 'text' }, expect.objectContaining({ name: 'diverse_founder' })],
      children: [
        {
          name: 'founder',
          position: 'Recap Entry.founder',
          fields: [{ name: 'first', type: 'text' }],
          children: [],
        },
      ],
    });
    // The base is shown as it was written.
    expect(result.story.shapes.find((s) => s.name === 'Entry')?.fields).toEqual([
      { name: 'name', type: 'text' },
    ]);
  });
});

