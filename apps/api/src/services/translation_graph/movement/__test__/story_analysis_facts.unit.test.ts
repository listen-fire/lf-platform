// The story analysis, read as the facts legacy-lang's projection draws from:
// one case per thing the projection reads (PLAN-17's coverage table).

import fs from 'node:fs';
import path from 'node:path';

import {
  LANGUAGE_VERSION,
  parseProgram,
  storyAnalysisInRust,
  type Span,
  type StoryAnalysis,
} from 'movement-lang';
import type { TraversalStep } from 'movement-lang/expression/types';
import { maybeAbsent } from 'legacy-lang';

import { analysisFacts } from '../story_analysis_facts';
import { storyFromAnalysis } from '../story_from_analysis';
import { STORY_VIEW_SNAPSHOT } from './__fixtures__/story/story_view';

const SOURCE = fs.readFileSync(path.join(__dirname, '__fixtures__/story/analysis_facts.mvt'), 'utf8');
const program = parseProgram(SOURCE, { languageVersion: LANGUAGE_VERSION });
const analysis = storyAnalysisInRust(SOURCE, STORY_VIEW_SNAPSHOT, { languageVersion: LANGUAGE_VERSION });
const facts = analysisFacts(analysis, program, LANGUAGE_VERSION);

const span = (line: number, col: number, endLine: number, endCol: number): Span => ({
  start: { line, col },
  end: { line: endLine, col: endCol },
});

const intake = program.statements.find((s) => s.kind === 'movement');
if (intake?.kind !== 'movement') throw new Error('the fixture declares intake');
const statementAt = (line: number) => {
  const found = intake.body.find((s) => s.span.start.line === line);
  if (found === undefined) throw new Error(`no statement on line ${line}`);
  return found;
};

/** A hand-built analysis, for the cases the fixture program cannot pin down. */
function synthetic(over: Partial<StoryAnalysis>): StoryAnalysis {
  return {
    storyAnalysisVersion: 1,
    diagnostics: [],
    scopes: [{ symbols: {} }],
    symbols: [],
    writes: [],
    nodes: [],
    bodies: [],
    shapes: [],
    ...over,
  };
}

describe('the story analysis as story facts', () => {
  it('is a clean program, so every fact is the check of something real', () => {
    expect(analysis.diagnostics).toEqual([]);
  });

  it('program and slot expressions: a slot reads under the pin, by the same release', () => {
    const write = statementAt(20);
    if (write.kind !== 'assign' || write.value.kind !== 'write') throw new Error('line 20 is a write');
    const title = write.value.write.fields[0];
    if (title === undefined) throw new Error('the write has a field');
    expect(facts.expressionOf(title.value)).toMatchObject({ type: 'traverse' });
  });

  it('frames: the innermost scope whose text holds a span, the file where none does', () => {
    const elseArm = facts.scopeAt(span(26, 5, 26, 34));
    expect(analysis.scopes[elseArm]?.span).toEqual(span(25, 5, 27, 4));
    expect(facts.scopeAt(span(32, 1, 32, 10))).toBe(0);
  });

  it('a scope with no text of its own is never the nearest', () => {
    const spanless = synthetic({
      scopes: [{ symbols: {} }, { parent: 0, symbols: {} }, { parent: 0, span: span(1, 1, 9, 1), symbols: {} }],
    });
    expect(analysisFacts(spanless, program, LANGUAGE_VERSION).scopeAt(span(2, 1, 2, 5))).toBe(2);
  });

  it('resolve: a parameter with its address, the position as the record type', () => {
    const inside = facts.scopeAt(statementAt(20).span);
    expect(facts.resolve(inside, 'n')).toMatchObject({ kind: 'param', address: { instance: 'desk', recordType: 'note' } });
    expect(facts.resolve(inside, 'org')).toMatchObject({ kind: 'binding', address: { instance: 'books', recordType: 'Orgs' } });
    expect(facts.resolve(inside, 'nobody')).toBeUndefined();
  });

  it('resolve: an extraction entity, absent at its root', () => {
    const at = span(1, 1, 1, 2);
    const extracted = synthetic({
      scopes: [{ symbols: { root: 0, company: 1 } }],
      symbols: [
        { name: 'root', kind: 'binding', span: at, extracted: {} },
        { name: 'company', kind: 'alias', span: at, extracted: { entity: 'company' } },
      ],
    });
    const read = analysisFacts(extracted, program, LANGUAGE_VERSION);
    expect(read.resolve(0, 'root')?.extracted).toEqual({});
    expect(read.resolve(0, 'company')?.extracted).toEqual({ entity: 'company' });
  });

  it('the ambiguity walk: every visible name once, an inner binding hiding an outer one', () => {
    const at = span(1, 1, 1, 2);
    const shadowed = synthetic({
      scopes: [{ symbols: { a: 0, b: 1 } }, { parent: 0, span: at, symbols: { a: 2, c: 3 } }],
      symbols: [
        { name: 'a', kind: 'binding', span: at },
        { name: 'b', kind: 'binding', span: at },
        { name: 'a', kind: 'param', span: at },
        { name: 'c', kind: 'binding', span: at },
      ],
    });
    const read = analysisFacts(shadowed, program, LANGUAGE_VERSION);
    expect(read.visibleNames(1).sort()).toEqual(['a', 'b', 'c']);
    expect(read.resolve(1, 'a')?.kind).toBe('param');
  });

  it("shapes: the declaration the check resolved, its base's members first", () => {
    const note = program.statements.find((s) => s.kind === 'shape' && s.name === 'Note');
    if (note?.kind !== 'shape') throw new Error('the fixture declares Note');
    expect(facts.shape(note)?.fields.map((f) => f.name)).toEqual(['title', 'mood', 'owner']);
  });

  it('writes: by span, with the scope as an id', () => {
    const write = facts.write(span(20, 9, 20, 50));
    expect(write).toMatchObject({ scope: 1, action: 'create', target: { instance: 'books', recordType: 'Orgs' } });
    expect(write?.fields.map((f) => f.name)).toEqual(['Title']);
  });

  it('nodes: an unlink is its own node, with the scope it stands in', () => {
    expect(facts.node('unlink', statementAt(22).span)?.scope).toBe(1);
    expect(facts.instances().map((i) => i.name)).toEqual(['desk', 'books']);
    expect(facts.listens().map((l) => l.fires)).toEqual(['intake']);
  });

  it("value paths: matched by structure, whatever order a step's keys come in", () => {
    const slot = span(3, 5, 3, 30);
    const written: TraversalStep[] = [{ type: 'edge', edgeTypeId: 'Entries', direction: 'outgoing' }];
    const reordered: TraversalStep[] = [{ direction: 'outgoing', edgeTypeId: 'Entries', type: 'edge' }];
    expect(Object.keys(reordered[0]!)).not.toEqual(Object.keys(written[0]!));
    const paths = synthetic({
      nodes: [
        { kind: 'valuePath', span: slot, scope: 0, key: 'never read', root: 'org', steps: reordered, landings: [null] },
      ],
    });
    const found = analysisFacts(paths, program, LANGUAGE_VERSION).valuePath(slot, 'org', written);
    expect(found).toMatchObject({ id: 'trv:0:3:5-3:30', root: 'org' });
  });

  it('landings: a hop that did not type has no landing', () => {
    const head = span(4, 1, 4, 20);
    const walks = synthetic({
      nodes: [
        {
          kind: 'traversal',
          span: head,
          scope: 0,
          steps: [],
          landings: [null, { instance: 'books', position: 'Orgs' }],
        },
      ],
    });
    expect(analysisFacts(walks, program, LANGUAGE_VERSION).node('traversal', head)?.landings).toEqual([
      undefined,
      { instance: 'books', position: 'Orgs' },
    ]);
  });

  it('bodies: each kind by its own span, a body never recorded capping nothing', () => {
    const branch = statementAt(23);
    if (branch.kind !== 'if' || branch.elseArm === undefined) throw new Error('line 23 is an if/else');
    expect(facts.terminates('movement', intake.span, intake.body)).toBe(false);
    expect(facts.terminates('arm', branch.arms[0]!.span, branch.arms[0]!.body)).toBe(true);
    expect(facts.terminates('else', branch.elseArm.span, branch.elseArm.body)).toBe(false);
    expect(facts.terminates('combinatorArm', span(28, 15, 28, 37), [])).toBe(true);
    expect(facts.terminates('combinatorArm', span(28, 39, 28, 60), [])).toBe(false);
    expect(facts.terminates('arm', span(1, 1, 1, 1), [])).toBe(false);
  });

  it("effects: the movement symbol's row; a lower bound where there is none", () => {
    expect(facts.movementEffects(1, 'intake')).toEqual({
      reads: [],
      writes: ['books'],
      ai: true,
      now: false,
      suspend: true,
      partial: false,
    });
    expect(facts.movementEffects(1, 'elsewhere')).toMatchObject({ reads: [], writes: [], partial: true });
  });

  it("extraction trees: the author's words and types, recovered from the syntax", () => {
    const extraction = statementAt(19);
    if (extraction.kind !== 'assign' || extraction.value.kind !== 'extractCall') throw new Error('line 19 extracts');
    const tree = facts.extractTree(extraction.value.extractCall.span, extraction.value.extractCall);
    // `Note extends Base` and writes no words of its own, so it reads as its base.
    expect(tree).toEqual({
      name: 'Note',
      description: 'the base',
      fields: [
        { name: 'title', description: 'a title', type: 'text', at: span(10, 3, 10, 26) },
        { name: 'mood', description: 'how it reads', type: { kind: 'enum', options: ['calm', 'cross'] }, at: span(14, 3, 14, 30) },
        { name: 'owner', description: 'who wrote it, if said', type: maybeAbsent('text'), at: span(15, 3, 15, 47) },
      ],
      children: [],
    });
  });

  it("calls: each argument's parameter, none past the last", () => {
    const at = span(5, 1, 5, 20);
    const calls = synthetic({
      nodes: [{ kind: 'call', span: at, scope: 0, callee: 'pdf', isMovement: false, argParams: ['text', null] }],
    });
    expect(analysisFacts(calls, program, LANGUAGE_VERSION).node('call', at)?.argParams).toEqual(['text', null]);
  });

  it("diagnostics: the story's verdict is the analysis's", () => {
    const broken = SOURCE.replace('Title: n.`text`', 'Nope: n.`text`');
    const { result, diagnostics } = storyFromAnalysis({ source: broken, snapshot: STORY_VIEW_SNAPSHOT, pin: LANGUAGE_VERSION });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(result.story.movement.validity.status).toBe('invalid');
    expect(result.story.movement.validity.problems.map((p) => p.code)).toEqual(diagnostics.map((d) => d.code));
  });

  it('a refused pin is unreadable with its version diagnostic, never an empty picture', () => {
    const { result } = storyFromAnalysis({ source: SOURCE, snapshot: STORY_VIEW_SNAPSHOT, pin: '0.13.0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.code).toMatch(/^MOV_LANGUAGE_VERSION_/);
  });
});
