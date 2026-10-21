// Positional analysis for the language service.
//
// The checker validates a whole program; an editor asks questions AT a
// position: which names are in scope here, what type does this one have,
// which write body am I inside? There is ONE typing walk — the checker's —
// and it RECORDS its scope frames and write regions when asked
// (`recordAnalysis`). This module is the cursor half: offsets ↔ locations,
// the frame/symbol/write lookups over that recording, and the editing
// tolerance a half-typed buffer needs.
//
// Editing states rarely parse — the statement being typed is incomplete —
// so `analyze` retries with the cursor's line blanked before giving up.
// The rest of the file is usually well-formed, which is exactly the scope
// information completions need.

import { Loc, Program, Span } from 'movement-lang/parser/ast';
import { MovementParseError, parseProgram } from 'movement-lang/parser/parse';
import {
  checkProgramWithLink,
  type CheckRecording,
  type RecordedFrame,
  type RecordedWrite,
} from '../checker/check';
import type { Declaration, Scope, ScopeSymbol } from '../checker/scopes';
import { isNestedCallName } from '../checker/nested_calls';
import { fromCatalogSnapshot, resolveFileFromSnapshot, type CatalogSnapshot } from 'movement-lang/service/snapshot';

// ── Offsets ↔ locations ──

export function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

export function offsetOfLoc(lineStarts: number[], loc: Loc): number {
  const lineStart = lineStarts[Math.min(loc.line, lineStarts.length) - 1] ?? 0;
  return lineStart + loc.col - 1;
}

export function locOfOffset(lineStarts: number[], offset: number): Loc {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
}

function cmpLoc(a: Loc, b: Loc): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

function spanContains(span: Span, loc: Loc): boolean {
  return cmpLoc(span.start, loc) <= 0 && cmpLoc(loc, span.end) <= 0;
}

function spanWithinSpan(inner: Span, outer: Span): boolean {
  return cmpLoc(outer.start, inner.start) <= 0 && cmpLoc(inner.end, outer.end) <= 0;
}

// ── Visibility ──

/**
 * Kinds visible across their whole frame wherever the cursor sits, because
 * that is how the checker binds them: movement and node declarations are
 * hoisted over their statement list, parameters and traversal aliases exist
 * for the whole body they head. Every other kind — imports, assignments —
 * is source-ordered.
 */
const HOISTED_KINDS: ReadonlySet<string> = new Set([
  'movement',
  'shape',
  'param',
  'alias',
]);

function visibleAt(declaration: Declaration, loc: Loc): boolean {
  return (
    HOISTED_KINDS.has(declaration.symbol.kind) || cmpLoc(declaration.visibleFrom, loc) <= 0
  );
}

/**
 * A scope's bindings AS OF `loc`: for each name, the last declaration already
 * in force there. A name declared only later in this scope is present with no
 * symbol — the checker would refuse it (use-before-bind), which is different
 * from the name not being bound in this scope at all.
 */
function bindingsAt(scope: Scope, loc: Loc): Map<string, ScopeSymbol | undefined> {
  const bindings = new Map<string, ScopeSymbol | undefined>();
  for (const declaration of scope.declarations ?? []) {
    const name = declaration.symbol.name;
    // A nested call's bound name is the checker's, not the author's.
    if (isNestedCallName(name)) continue;
    if (visibleAt(declaration, loc)) bindings.set(name, declaration.symbol);
    else if (!bindings.has(name)) bindings.set(name, undefined);
  }
  return bindings;
}

/**
 * The checker's recording, indexed for cursor queries.
 *
 * Nothing here re-derives a type: every symbol is the ScopeSymbol the
 * checker bound, and every write region's root is the shape the checker
 * validated that body against.
 */
export class Analysis {
  readonly frames: RecordedFrame[];
  readonly writes: RecordedWrite[];

  constructor(recording?: CheckRecording) {
    this.frames = recording?.frames ?? [];
    this.writes = recording?.writes ?? [];
  }

  /** Innermost frame containing `loc` (the file frame contains everything). */
  frameAt(loc: Loc): RecordedFrame | undefined {
    let best: RecordedFrame | undefined;
    for (const frame of this.frames) {
      if (frame.kind !== 'file' && !spanContains(frame.span, loc)) continue;
      if (!best || isInside(frame, best)) best = frame;
    }
    return best;
  }

  /**
   * All names the checker would resolve at `loc`, inner shadowing outer.
   *
   * The rule is the checker's own resolution, read forwards: walk out from
   * the innermost frame taking the first binding of each name, and stop at
   * what the checker would REFUSE — a name whose binding statement the cursor
   * has not reached yet, which shadows any outer binding exactly as the
   * checker's pending set does. Names the checker would reject are NOT offered: the
   * completion list is checker truth, not a superset of it.
   *
   * A name can be declared more than once in a scope — a guard clause
   * re-declares its subject narrowed for its continuation — so the answer is
   * the last declaration in force at `loc`, not the scope's final binding.
   */
  symbolsAt(loc: Loc): Map<string, ScopeSymbol> {
    const visible = new Map<string, ScopeSymbol>();
    const refused = new Set<string>();
    for (let scope: Scope | undefined = this.frameAt(loc)?.scope; scope; scope = scope.parent) {
      for (const [name, symbol] of bindingsAt(scope, loc)) {
        if (visible.has(name) || refused.has(name)) continue;
        if (symbol) visible.set(name, symbol);
        else refused.add(name);
      }
    }
    return visible;
  }

  resolveAt(name: string, loc: Loc): ScopeSymbol | undefined {
    const visible = this.symbolsAt(loc).get(name);
    if (visible) return visible;
    // Hovering the declaration itself (`crm = attio(…)`): the symbol is not
    // yet "visible" at its own binding statement, but it is the right answer.
    // The DECLARED symbol, not a later narrowing of it — a narrowing shadows
    // the declaration's span, so take the first match.
    for (let scope: Scope | undefined = this.frameAt(loc)?.scope; scope; scope = scope.parent) {
      for (const { symbol } of scope.declarations ?? []) {
        if (symbol.name === name && spanContains(symbol.span, loc)) return symbol;
      }
    }
    return undefined;
  }

  /** Innermost write region containing `loc`. */
  writeAt(loc: Loc): RecordedWrite | undefined {
    let best: RecordedWrite | undefined;
    for (const region of this.writes) {
      if (!spanContains(region.span, loc)) continue;
      if (!best || spanWithinSpan(region.span, best.span)) best = region;
    }
    return best;
  }
}

function isInside(inner: RecordedFrame, outer: RecordedFrame): boolean {
  if (outer.kind === 'file') return true;
  if (inner.kind === 'file') return false;
  return spanWithinSpan(inner.span, outer.span);
}

// ── Entry point ──

/**
 * One recorded check per (snapshot, parsed text). Completions, hover and
 * definition all ask about the SAME buffer, and each question would
 * otherwise re-check every imported library; the key is the text actually
 * PARSED (blanked line included), so a keystroke misses and a second
 * question about the same edit hits. One entry per snapshot — the current
 * buffer is the only one anyone asks about — in a WeakMap so a superseded
 * snapshot is collectable.
 */
const CHECKED = new WeakMap<CatalogSnapshot, { parsed: string; analysis: Analysis }>();

/**
 * Parses with editing tolerance, then checks with recording on: the raw
 * source first; when that fails, the cursor's line blanked (the statement
 * being typed is the usual culprit, and the rest of the file is
 * well-formed). An unrecoverable parse yields an empty analysis — every
 * lookup then answers "nothing here", which is what a buffer with no
 * structure means.
 */
export function analyze(
  source: string,
  snapshot: CatalogSnapshot,
  options: { cursorOffset?: number } = {},
): Analysis {
  const candidates = [source];
  if (options.cursorOffset !== undefined) {
    const blanked = blankLineAt(source, options.cursorOffset);
    if (blanked !== source) candidates.push(blanked);
  }
  const resolveFile = resolveFileFromSnapshot(snapshot);
  for (const text of candidates) {
    const cached = CHECKED.get(snapshot);
    if (cached?.parsed === text) return cached.analysis;
    let program: Program;
    try {
      program = parseProgram(text);
    } catch (e) {
      if (!(e instanceof MovementParseError)) throw e;
      continue;
    }
    const { recording } = checkProgramWithLink(program, fromCatalogSnapshot(snapshot), {
      recordAnalysis: true,
      ...(resolveFile ? { resolveFile } : {}),
    });
    const analysis = new Analysis(recording);
    CHECKED.set(snapshot, { parsed: text, analysis });
    return analysis;
  }
  return new Analysis();
}

function blankLineAt(source: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, source.length));
  const lineStart = source.lastIndexOf('\n', clamped - 1) + 1;
  let lineEnd = source.indexOf('\n', clamped);
  if (lineEnd === -1) lineEnd = source.length;
  const line = source.slice(lineStart, lineEnd);
  return source.slice(0, lineStart) + ' '.repeat(line.length) + source.slice(lineEnd);
}
