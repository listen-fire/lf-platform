// The story projection of a release pin, from the wasm's story analysis: the
// assertions legacy-lang's story suite made about a program only the current
// language can spell (functions, `connect … using`, an extraction with
// described fields, callbacks, `first(…)`), moved here when legacy-lang's
// presentation stopped reading the current surface. The programs and the
// snapshot are `legacy_story.ts`'s; each is drawn by `storyFromAnalysis`.
//
// Three DIFFERENT adapter shapes on purpose — a fixture matching one adapter's
// shape cannot tell derived from hardcoded, and adapter-blindness is the whole
// claim being tested here.

import { LANGUAGE_VERSION } from 'movement-lang';
import type { Chip, StoryIR, StoryReference, StoryResult, Step } from 'legacy-lang';

import { storyFromAnalysis } from '../story_from_analysis';
import { CALLBACK_SOURCE, LEGACY_STORY_SNAPSHOT, SOURCE, TRAVERSALS } from './__fixtures__/story/legacy_story';

function storyOf(input: { source: string; name?: string }): StoryResult {
  return storyFromAnalysis({ ...input, snapshot: LEGACY_STORY_SNAPSHOT, pin: LANGUAGE_VERSION }).result;
}

function story(): StoryIR {
  const result = storyOf({ source: SOURCE, name: 'Deal intake' });
  if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
  return result.story;
}

/** The steps of the movement the trigger fires, flattened one level. */
function intakeSteps(ir: StoryIR): Step[] {
  const movement = ir.flow.find((s) => s.kind === 'movement' && s.name === 'intake');
  if (movement === undefined || movement.kind !== 'movement') throw new Error('no intake movement');
  return movement.steps;
}

function stepsOfKind<K extends Step['kind']>(steps: Step[], kind: K): Array<Extract<Step, { kind: K }>> {
  return steps.filter((s): s is Extract<Step, { kind: K }> => s.kind === kind);
}

// ── The story ──

describe('storyOf — the whole IR', () => {
  it('carries the movement name and a truthful validity', () => {
    const ir = story();
    expect(ir.movement.name).toBe('Deal intake');
    // Under 5 the fixture's extraction keyword is retired, and that is its one error.
    expect(ir.movement.validity.status).toBe('invalid');
    expect(ir.movement.validity.problems.filter((p) => p.severity === 'error').map((p) => p.code)).toEqual(['MOV_EXTRACT_KEYWORD_RETIRED']);
  });

  it('renders the truth for an INVALID program rather than refusing it', () => {
    const result = storyOf({
      source: `${SOURCE}\nmovement broken(m: <inbox-[:message]->>) { write book-[:Nope]-> { Name: "x" } }`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.story.movement.validity.status).toBe('invalid');
    expect(result.story.movement.validity.problems.some((p) => p.severity === 'error')).toBe(true);
    // The rest of the story is still there — a broken movement does not erase
    // the good ones.
    expect(result.story.triggers).toHaveLength(1);
  });

  it('names the constructed instances and their adapter types, opaquely', () => {
    expect(story().instances.map((i) => [i.name, i.adapterType])).toEqual([
      ['inbox', 'mail'],
      ['book', 'crm_sys'],
      ['questions', 'asksys'],
    ]);
  });
});

describe('triggers', () => {
  it('projects the listen with its declared event selection and address', () => {
    const [trigger] = story().triggers;
    expect(trigger.instance.name).toBe('inbox');
    expect(trigger.instance.declaredAt).toBeDefined();
    expect(trigger.adapterType).toBe('mail');
    expect(trigger.events).toEqual(['message.received']);
    expect(trigger.narrowing).toEqual({ key: 'dealflow' });
    expect(trigger.fires).toBe('intake');
    expect(trigger.firesMovement).toBe(true);
    expect(trigger.eventTypes.length).toBeGreaterThan(0);
  });
});

describe('records — the inspectRun sibling rows', () => {
  it('mirrors {binding, target, action, values} with expressions as chips', () => {
    const ir = story();
    const company = ir.records.find((r) => r.binding === 'c');
    expect(company).toBeDefined();
    expect(company!.target).toEqual({
      adapterType: 'crm_sys',
      instance: 'book',
      recordType: 'Companies',
    });
    expect(company!.action).toBe('create');
    expect(company!.fields.Name).toEqual({
      source: 'facts.name',
      role: 'reference',
      refs: [{ name: 'facts', declaredAt: expect.anything() }],
      parts: [
        {
          kind: 'reference',
          reference: {
            source: 'facts.name',
            root: { name: 'facts', declaredAt: expect.anything() },
            field: 'name',
            // `facts` holds the extraction's synthetic ROOT — nobody named it,
            // so no entity name is claimed for it.
            origin: { kind: 'extracted' },
          },
        },
      ],
    });
    expect(company!.uniqueBy.map((c) => c.source)).toEqual(['`Name`']);
  });

  it('a position write is an UPDATE of the record it already holds', () => {
    const updates = story().records.filter((r) => r.action === 'update');
    expect(updates).toHaveLength(2);
    expect(updates.map((r) => r.fields.Stage.source)).toEqual(['"big"', '"small"']);
    expect(updates.every((r) => r.target.recordType === 'Deals')).toBe(true);
  });

  it('a match FINDS a record — a graph row that is never written, and draws no parent edge', () => {
    const ir = story();
    const found = ir.records.filter((r) => r.action === 'find');
    expect(found).toHaveLength(1);
    expect(found[0].binding).toBe('lead');
    expect(found[0].target.recordType).toBe('People');
    expect(found[0].fields.Name.source).toBe('"sam"');
    expect(found[0].uniqueBy.map((c) => c.source)).toEqual(['`Name`']);
    expect(ir.edges.filter((e) => e.kind === 'parent' && e.to.kind === 'record' && e.to.id === found[0].id)).toEqual([]);
    const step = stepsOfKind(intakeSteps(ir), 'match')[0];
    expect(step).toMatchObject({ kind: 'match', record: found[0].id, binding: 'lead' });
  });

  it('chips classify interpolation and AI apart from plain literals', () => {
    const deal = story().records.find((r) => r.binding === 'd');
    expect(deal!.fields.Title.role).toBe('interpolation');
    expect(deal!.fields.Title.refs.map((r) => r.name)).toEqual(['facts']);
    expect(deal!.fields.Summary.role).toBe('ai');
  });
});

describe('edges — the record graph', () => {
  it('a linked write contributes its parent edge', () => {
    const ir = story();
    const company = ir.records.find((r) => r.binding === 'c')!;
    const deal = ir.records.find((r) => r.binding === 'd')!;
    expect(ir.edges).toContainEqual({
      from: { kind: 'record', id: company.id },
      to: { kind: 'record', id: deal.id },
      edge: 'Deals',
      kind: 'parent',
    });
  });

  it('a link statement contributes a link edge to the found record', () => {
    const ir = story();
    const company = ir.records.find((r) => r.binding === 'c')!;
    const owner = ir.records.find((r) => r.action === 'find')!;
    expect(ir.edges).toContainEqual({
      from: { kind: 'record', id: company.id },
      to: { kind: 'record', id: owner.id },
      edge: 'Owner',
      kind: 'link',
    });
  });

  it("an ask's awaited resolution is a response edge off the record we raised", () => {
    const ir = story();
    const ask = ir.records.find((r) => r.binding === 'a')!;
    const response = ir.edges.find((e) => e.kind === 'response');
    expect(response).toEqual({
      from: { kind: 'record', id: ask.id },
      to: { kind: 'binding', ref: { name: 'answer', declaredAt: expect.anything() } },
      edge: 'Response',
      kind: 'response',
    });
  });
});

describe('flow — pauses and branches are step kinds, nested in place', () => {
  it('the file flow is its movements, each with its own body', () => {
    expect(story().flow.map((s) => s.kind === 'movement' && s.name)).toEqual([
      'note_owner',
      'intake',
    ]);
  });

  it('an awaitable edge off a record we raised is an ASK pause, not a plain wait', () => {
    const ir = story();
    const asks = stepsOfKind(intakeSteps(ir), 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0].edge).toBe('Response');
    expect(asks[0].binding).toBe('answer');
    expect(asks[0].record).toBe(ir.records.find((r) => r.binding === 'a')!.id);
  });

  it('a race carries its arms, and a sleep inside one is a wait', () => {
    const races = stepsOfKind(intakeSteps(story()), 'race');
    expect(races).toHaveLength(1);
    expect(races[0].combinator).toBe('race');
    expect(races[0].binding).toBe('timing');
    expect(races[0].branches).toHaveLength(2);
    expect(races[0].branches[0].steps).toEqual([
      expect.objectContaining({ kind: 'wait', wait: { kind: 'sleep', duration: '2d' } }),
    ]);
    expect(races[0].branches[1].steps).toEqual([
      expect.objectContaining({ kind: 'return' }),
    ]);
  });

  // The intake's first branch is the guard on the found owner (since language
  // version 4 a match may find nothing); the cases below are about the second.
  const amountBranch = () => stepsOfKind(intakeSteps(story()), 'branch')[1];

  it('a branch nests its arms and its else, with the condition as a chip', () => {
    const all = stepsOfKind(intakeSteps(story()), 'branch');
    expect(all.map((b) => b.arms[0].condition.source)).toEqual(['lead != null', 'amount > 1000']);
    expect(all[0].arms[0].steps.map((s) => s.kind)).toEqual(['link']);
    const branches = [amountBranch()];
    expect(branches[0].arms).toHaveLength(1);
    expect(branches[0].arms[0].condition.source).toBe('amount > 1000');
    expect(branches[0].arms[0].condition.refs.map((r) => r.name)).toEqual(['amount']);
    expect(branches[0].arms[0].steps.map((s) => s.kind)).toEqual(['write']);
    expect(branches[0].otherwise!.steps.map((s) => s.kind)).toEqual(['write']);
  });

  it('an arm and its otherwise carry `terminates` — false here, neither ends in ERROR', () => {
    const branches = [amountBranch()];
    expect(branches[0]!.arms[0]!.terminates).toBe(false);
    expect(branches[0]!.otherwise!.terminates).toBe(false);
  });

  it('a race arm carries `terminates` too — the same fact, off the arm body', () => {
    const races = stepsOfKind(intakeSteps(story()), 'race');
    expect(races[0]!.branches[0]!.terminates).toBe(false);
    expect(races[0]!.branches[1]!.terminates).toBe(false);
  });

  it('an extraction carries its sources and its resolved tree', () => {
    const extracts = stepsOfKind(intakeSteps(story()), 'extract');
    expect(extracts).toHaveLength(1);
    expect(extracts[0].binding).toBe('facts');
    expect(extracts[0].from.map((c) => c.source)).toEqual(['m.`body`']);
    const tree = extracts[0].tree!;
    expect(tree.fields.map((f) => [f.name, f.type])).toEqual([
      ['name', 'text'],
      ['amount', 'number'],
    ]);
    expect(tree.children.map((c) => c.name)).toEqual(['company']);
    expect(tree.children[0].fields.map((f) => f.name)).toEqual(['domain']);
  });

  it('the tree carries the whole graph — every node, its fields, and the words the author gave each one', () => {
    const extracts = stepsOfKind(intakeSteps(story()), 'extract');
    const tree = extracts[0].tree!;

    // The root is synthetic: nobody declared it, so it describes nothing.
    expect(tree.description).toBeUndefined();
    expect(tree.fields.map((f) => [f.name, f.description])).toEqual([
      ['name', "the person's name"],
      ['amount', 'the deal size'],
    ]);

    const company = tree.children[0];
    expect(company.description).toBe('the company they are from');
    expect(company.fields).toEqual([
      expect.objectContaining({ name: 'domain', description: 'the web domain', type: 'text' }),
    ]);

    // Nesting is carried to any depth — a child's child is a node like any other.
    const colleague = company.children[0];
    expect(colleague.name).toBe('colleague');
    expect(colleague.description).toBe('everyone else named at that company');
    expect(colleague.fields.map((f) => f.description)).toEqual(['their full name']);
  });

  it('a field annotated `<text | null>` is said as written: text, or nothing', () => {
    const source = SOURCE.replace('domain: <text> "the web domain"', 'domain: <text | null> "the web domain"');
    const result = storyOf({ source, name: 'Deal intake' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const tree = stepsOfKind(intakeSteps(result.story), 'extract')[0].tree!;
    expect(tree.children[0].fields.map((f) => [f.name, f.type])).toEqual([
      ['domain', { kind: 'maybeAbsent', of: 'text' }],
    ]);
    expect(tree.fields.map((f) => [f.name, f.type])).toEqual([
      ['name', 'text'],
      ['amount', 'number'],
    ]);
  });

  it('a call names the movement and says whether the name resolved to one', () => {
    const calls = stepsOfKind(intakeSteps(story()), 'call');
    expect(calls).toHaveLength(1);
    expect(calls[0].movement).toBe('note_owner');
    expect(calls[0].isMovement).toBe(true);
    expect(calls[0].args).toEqual([
      { name: 'co', kind: 'value', chip: expect.objectContaining({ source: 'c' }) },
    ]);
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

  it('a parameter read is the EVENT that came in, with the declared field', () => {
    const ir = story();
    const extract = stepsOfKind(intakeSteps(ir), 'extract')[0];
    const reference = referenceOf(extract.from[0]);
    expect(reference.root.name).toBe('m');
    expect(reference.field).toBe('body');
    expect(reference.origin).toEqual({
      kind: 'event',
      target: { adapterType: 'mail', instance: 'inbox', recordType: 'message' },
    });
  });

  it('a write handle is the RECORD this flow wrote, by id', () => {
    const ir = story();
    const company = ir.records.find((r) => r.binding === 'c')!;
    const call = stepsOfKind(intakeSteps(ir), 'call')[0];
    const arg = call.args[0];
    if (arg?.kind !== 'value') throw new Error('expected a value argument');
    expect(referenceOf(arg.chip).origin).toEqual({ kind: 'record', record: company.id });
  });

  it('an extraction alias carries the name the AUTHOR gave the node', () => {
    // `facts.name` reads the synthetic root; a named node reads as itself.
    const ir = story();
    const deal = ir.records.find((r) => r.binding === 'd')!;
    expect(referenceOf(deal.fields.Title).origin).toEqual({ kind: 'extracted' });
  });

  it('a template splits at the AST — literal runs and referents, never a scan', () => {
    const deal = story().records.find((r) => r.binding === 'd')!;
    expect(deal.fields.Title.parts).toEqual([
      { kind: 'text', text: 'Deal — ' },
      expect.objectContaining({ kind: 'reference' }),
    ]);
  });

  it('a condition splits into its two sides and the operator between them', () => {
    const branch = stepsOfKind(intakeSteps(story()), 'branch')[1];
    expect(branch.arms[0].condition.parts).toEqual([
      {
        kind: 'test',
        operator: 'gt',
        // The subject is a referent; the operator is the LANGUAGE's token, and
        // the word for it is the renderer's.
        subject: [
          expect.objectContaining({
            kind: 'reference',
            reference: expect.objectContaining({ source: 'amount' }),
          }),
        ],
        against: [{ kind: 'expression', source: '1000', refs: [] }],
      },
    ]);
  });

  it('a value-position WALK carries its hops and landings, like a for-each head', () => {
    const result = storyOf({
      source: `${SOURCE.replace(
        '  a = write questions-[:Check]->',
        '  owner = c-[:Owner]->.Name\n  a = write questions-[:Check]->',
      )}`,
    });
    if (!result.ok) throw new Error('expected a story');
    const value = stepsOfKind(intakeSteps(result.story), 'value').find(
      (s) => s.binding === 'owner',
    );
    const reference = referenceOf(value!.value);
    expect(reference.field).toBe('Name');
    expect(reference.path).toEqual([
      { edge: 'Owner', landing: { adapterType: 'crm_sys', instance: 'book', recordType: 'People' } },
    ]);
  });

  it('an expression shown WHOLE says which names are visible inside it', () => {
    const result = storyOf({
      source: `${SOURCE.replace(
        '  a = write questions-[:Check]->',
        '  pick = IF facts.amount > 1 THEN facts.name ELSE "none" END\n  a = write questions-[:Check]->',
      )}`,
    });
    if (!result.ok) throw new Error('expected a story');
    const value = stepsOfKind(intakeSteps(result.story), 'value').find((s) => s.binding === 'pick');
    // Nothing splits a conditional, so its text stands — and the names in that
    // text are the ones a reader is left to make sense of.
    expect(value!.value.parts).toEqual([{ kind: 'text', text: expect.stringContaining('IF') }]);
    expect(value!.value.refs.map((r) => r.name)).toEqual(['facts']);
  });

  it('a read with a WALK in it is shown whole — a phrase would leave the walk out', () => {
    const ir = story();
    const owner = ir.records.find((r) => r.action === 'find')!;
    // `"sam"` is a literal: no reference, one text part carrying the source.
    expect(owner.fields.Name.parts).toEqual([{ kind: 'text', text: '"sam"' }]);
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
    const result = storyOf({ source: ASSEMBLED });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'build');
    if (movement?.kind !== 'movement') throw new Error('expected the build movement');
    return movement.steps;
  }

  // A pass-through entry is where the values come FROM, and that is a referent
  // like any other. Carrying only the path's text is what left a card saying
  // `facts-[c:company]->` — the one form the renderer could not put in words.
  it('a pass-through traversal entry composes a referent, not the path as text', () => {
    const source = `${SOURCE.replace(
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
`;
    const result = storyOf({ source });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const call = stepsOfKind(intakeSteps(result.story), 'call')[0];
    const arg = call?.args[0];
    if (arg?.kind !== 'node') throw new Error('expected a node argument');
    const chip = arg.node.fields.company;
    expect(chip.source).toBe('facts-[c:company]->');
    const part = chip.parts[0];
    if (part?.kind !== 'reference') throw new Error(`no reference in ${chip.source}`);
    expect(part.reference.path?.map((hop) => hop.edge)).toEqual(['company']);
    expect(part.reference.field).toBeUndefined();
    // The root is the extraction result, and the phrase downstream says so.
    expect(part.reference.origin).toEqual({ kind: 'extracted' });
  });
});

// ── Traversals ──
//
// The one authored form whose TEXT is pure syntax. Every assertion below is
// about the projection carrying STRUCTURE — hops, landings, comparisons — so a
// renderer can compose a sentence without ever seeing `-[…]->`.

function groups(): Array<Extract<Step, { kind: 'group' }>> {
  const result = storyOf({ source: TRAVERSALS, name: 'Flows' });
  if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
  const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'flows');
  if (movement === undefined || movement.kind !== 'movement') throw new Error('no flows movement');
  return stepsOfKind(movement.steps, 'group');
}

describe('traversals project as structure, never as syntax', () => {

  it('a collection hop carries its binding, its edge and the landing the CHECKER resolved', () => {
    const [simple] = groups();
    expect(simple.over.root!.name).toBe('book');
    expect(simple.over.from).toBe('graph');
    expect(simple.over.hops).toHaveLength(1);
    expect(simple.over.hops[0]!.binding).toBe('one');
    expect(simple.over.hops[0]!.edge).toBe('Companies');
    expect(simple.over.hops[0]!.landing).toEqual({
      adapterType: 'crm_sys',
      instance: 'book',
      recordType: 'Companies',
    });
  });

  it('a simple WHERE becomes comparisons — field, operator, value chip', () => {
    const [simple] = groups();
    expect(simple.over.hops[0]!.filter).toEqual({
      kind: 'comparisons',
      all: [
        {
          field: 'Name',
          operator: 'eq',
          value: {
            source: '"acme"',
            role: 'literal',
            refs: [],
            parts: [{ kind: 'text', text: '"acme"' }],
          },
        },
      ],
    });
  });

  it('a conjunction stays comparisons — every clause, in order', () => {
    const conjunction = groups()[1]!;
    const filter = conjunction.over.hops[0]!.filter!;
    expect(filter.kind).toBe('comparisons');
    if (filter.kind !== 'comparisons') return;
    expect(filter.all.map((c) => [c.field, c.operator, c.value.source])).toEqual([
      ['Name', 'eq', '"acme"'],
      ['Name', 'neq', '"other"'],
    ]);
  });

  it('anything else is carried WHOLE as one expression chip, never flattened', () => {
    const complex = groups()[2]!;
    const filter = complex.over.hops[0]!.filter!;
    expect(filter.kind).toBe('expression');
    if (filter.kind !== 'expression') return;
    // The whole filter, as the author's own operator — an OR read as a list of
    // ANDed clauses would say the opposite of what was written.
    expect(filter.chip.source).toContain('OR');
    expect(filter.chip.role).toBe('literal');
  });

  it('a two-hop path is two hops, each with its own landing', () => {
    const chain = groups()[3]!;
    expect(chain.over.hops.map((h) => [h.binding, h.edge])).toEqual([
      ['co', 'Companies'],
      ['deal', 'Deals'],
    ]);
    expect(chain.over.hops.map((h) => h.landing?.recordType)).toEqual(['Companies', 'Deals']);
    expect(chain.over.hops.every((h) => h.filter === undefined)).toBe(true);
  });

  it('a walk off a RESULT says so — and its landing comes from a different adapter shape', () => {
    const reply = groups()[4]!;
    expect(reply.over.from).toBe('result');
    expect(reply.over.hops[0]!.edge).toBe('Response');
    expect(reply.over.hops[0]!.landing).toEqual({
      adapterType: 'asksys',
      instance: 'questions',
      recordType: 'response',
    });
  });

  it('a combinator arm walks off a RESULT the same way any body does', () => {
    // The race's own value is a positional receipt (a value, not a node), so
    // the walk that used to hang off the receipt now lives INSIDE the arm.
    const [race] = stepsOfKind(
      (() => {
        const result = storyOf({ source: TRAVERSALS, name: 'Flows' });
        if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
        const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'flows');
        if (movement === undefined || movement.kind !== 'movement') throw new Error('no flows movement');
        return movement.steps;
      })(),
      'race',
    );
    expect(race!.binding).toBe('outcome');
    expect(race!.branches).toHaveLength(2);
  });

});

describe('serializability — the projection is the point at which identity settles', () => {
  it('a JSON round-trip loses nothing', () => {
    const ir = story();
    expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
  });

  it('nothing in the IR is a live Scope, a Map, or a Set', () => {
    const offenders: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (value instanceof Map || value instanceof Set) offenders.push(`${path}: collection`);
      if (Array.isArray(value)) return value.forEach((v, i) => visit(v, `${path}[${i}]`));
      if (value !== null && typeof value === 'object') {
        if (value.constructor !== Object) offenders.push(`${path}: ${value.constructor.name}`);
        for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
      }
      if (typeof value === 'function') offenders.push(`${path}: function`);
    };
    visit(story(), 'story');
    expect(offenders).toEqual([]);
  });
});

// ── Deferred actions, folds over walks, and the receipt branch ──
//
// A second program, from the shape of a real callback+race movement: two
// deferred actions raced against a timer, a message whose payload carries their
// ids by hand, a channel found with a fold over a walk, and a branch on the
// race receipt's timer slot.

function callbackStory(): StoryIR {
  const result = storyOf({ source: CALLBACK_SOURCE, name: 'Approve' });
  if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
  return result.story;
}

function approveSteps(): Step[] {
  const movement = callbackStory().flow.find((s) => s.kind === 'movement' && s.name === 'approve');
  if (movement === undefined || movement.kind !== 'movement') throw new Error('no approve movement');
  return movement.steps;
}

describe('callbacks — a deferred action, with the steps that run when it is used', () => {

  it('carries the BODY as steps, projected like any other block', () => {
    const [callback] = stepsOfKind(approveSteps(), 'callback');
    const [write] = stepsOfKind(callback!.steps, 'write');
    expect(write).toBeDefined();
    // The write inside is a row of the record graph like any other, so the
    // canvas draws the same card for it.
    const record = callbackStory().records.find((r) => r.id === write!.record);
    expect(record!.target).toEqual({
      adapterType: 'crm_sys',
      instance: 'book',
      recordType: 'Companies',
    });
    expect(record!.fields.Name!.source).toBe('"approved"');
  });

});

describe('race lanes — what each contender waits ON, not just the edge it waits for', () => {
  it('each callback await carries the deferred action it waits on', () => {
    const [race] = stepsOfKind(approveSteps(), 'race');
    const waits = race!.branches.map((b) => b.steps[0]);
    expect(waits.map((w) => (w?.kind === 'wait' ? w.wait : undefined))).toEqual([
      { kind: 'edge', on: { kind: 'binding', ref: expect.anything() }, edge: 'Called', origin: { kind: 'callback', name: 'yes' } },
      { kind: 'edge', on: { kind: 'binding', ref: expect.anything() }, edge: 'Called', origin: { kind: 'callback', name: 'no' } },
      { kind: 'sleep', duration: '1d' },
    ]);
  });

  it('the lanes are in the arms\' own order, which is the receipt\'s slot order', () => {
    const [race] = stepsOfKind(approveSteps(), 'race');
    const timer = race!.branches[2]!.steps[0];
    expect(timer?.kind === 'wait' && timer.wait).toEqual({ kind: 'sleep', duration: '1d' });
    expect(race!.binding).toBe('r');
  });
});

describe('a fold over a walk — the call composes over the walk’s structure', () => {
  it('ONLY(<walk>) travels as the fold plus the walk, never as raw syntax', () => {
    const [value] = stepsOfKind(approveSteps(), 'value');
    expect(value!.binding).toBe('co');
    const [part] = value!.value.parts;
    expect(part!.kind).toBe('walk');
    if (part!.kind !== 'walk') return;
    expect(part.fn).toBe('only');
    expect(part.traversal.hops).toEqual([
      {
        binding: 'c',
        edge: 'Companies',
        landing: { adapterType: 'crm_sys', instance: 'book', recordType: 'Companies' },
        filter: {
          kind: 'comparisons',
          all: [{ field: 'Name', operator: 'eq', value: expect.objectContaining({ source: '"Acme"' }) }],
        },
      },
    ]);
    // The author's own text survives, for a fold this page has no word for.
    expect(part.source).toContain('ONLY');
  });

});

describe('the receipt is read by SLOT — the timeout branch is one null check', () => {
  it('the branch condition names the race binding and the slot it reads', () => {
    const [branch] = stepsOfKind(approveSteps(), 'branch');
    expect(branch!.arms[0]!.condition.source).toBe('r[2] == null');
    expect(branch!.arms[0]!.condition.refs.map((ref) => ref.name)).toEqual(['r']);
  });
});
