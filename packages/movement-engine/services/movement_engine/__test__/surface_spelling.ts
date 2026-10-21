// A suite that runs one program under every language version writes it once,
// in the spelling versions 1–4 read, and runs the version-5 case on the program
// the upgrade rewrites it to — so a version-5 run always reads the version-5
// surface. Only the respellings are applied (the `MOV_V5_*` fixes): a fix for
// the error a test is about never is. The check is the Rust checker's, against
// the run's snapshot, which carries the saved files file imports resolve to.
//
// The rewrite loop is the one the platform's `upgradeSource` runs (legacy-lang),
// reduced to the case this suite uses: every offered fix, outermost first, a
// fix that overlaps one already taken waiting for the next pass.

import { applyFix, type DiagnosticFix, type SourceEdit } from 'movement-lang/checker/fixes';
import { checkSourceInRust, RustCheckRefused } from 'movement-lang/checker/rust_checker';
import { rustParseProgram } from 'movement-lang/parser/rust_parser';
import type { Diagnostic } from 'movement-lang/checker/diagnostic';
import type { Loc, Span } from 'movement-lang/parser/ast';
import type { CatalogSnapshot } from 'movement-lang/service/snapshot';

const MAX_PASSES = 16;

const isRespelling = (d: Diagnostic): boolean => d.code.startsWith('MOV_V5_');

/** The old spellings alone, from the parse: what is checked with no catalog. */
function spellingFindings(source: string, version: number): Diagnostic[] {
  const parse = rustParseProgram(source, version);
  if (!parse.ok) return [];
  return (parse.value.spelling ?? []).map((f) => ({
    code: f.code,
    message: f.message,
    span: f.span,
    ...(f.fix !== undefined ? { fix: f.fix } : {}),
  }));
}

function respellings(source: string, version: number, snapshot: CatalogSnapshot | undefined): Diagnostic[] {
  if (snapshot === undefined) return spellingFindings(source, version).filter(isRespelling);
  try {
    return checkSourceInRust(source, snapshot, { languageVersion: version }).filter(isRespelling);
  } catch (error) {
    if (error instanceof RustCheckRefused) return [];
    throw error;
  }
}

/** `source` as `version` spells it. With a snapshot, the respellings only a
 *  check can decide (a built-in read by its argument's type, a call's named
 *  arguments put in order) are applied too. */
export function spelledFor(version: number, source: string, snapshot?: CatalogSnapshot): string {
  if (version < 5) return source;
  let text = source;
  for (let i = 0; i < MAX_PASSES; i++) {
    const fixes = fixesToApply(respellings(text, version, snapshot));
    if (fixes.length === 0) return text;
    const rewritten = applyFix(text, { edits: fixes.flatMap((f) => f.edits) });
    if (rewritten === text) return text;
    text = rewritten;
  }
  return text;
}

function fixesToApply(diagnostics: Diagnostic[]): DiagnosticFix[] {
  const offered = diagnostics
    .filter((d) => (d.severity ?? 'error') === 'error' || d.upgrade === true)
    .map((d) => d.fix)
    .filter((fix): fix is DiagnosticFix => fix !== undefined && fix.edits.length > 0);
  const extent = (fix: DiagnosticFix): Span => ({
    start: fix.edits.map((e) => e.span.start).reduce((a, b) => (compareLoc(a, b) <= 0 ? a : b)),
    end: fix.edits.map((e) => e.span.end).reduce((a, b) => (compareLoc(a, b) >= 0 ? a : b)),
  });
  offered.sort((a, b) => {
    const x = extent(a);
    const y = extent(b);
    return compareLoc(x.start, y.start) || compareLoc(y.end, x.end);
  });
  const taken: DiagnosticFix[] = [];
  const seen = new Set<string>();
  for (const fix of offered) {
    const key = JSON.stringify(fix.edits);
    if (seen.has(key)) continue;
    if (taken.some((t) => t.edits.some((a) => fix.edits.some((b) => editsOverlap(a, b))))) continue;
    seen.add(key);
    taken.push(fix);
  }
  return taken;
}

function editsOverlap(a: SourceEdit, b: SourceEdit): boolean {
  const empty = (e: SourceEdit): boolean => compareLoc(e.span.start, e.span.end) === 0;
  if ((empty(a) || empty(b)) && compareLoc(a.span.start, b.span.start) === 0) return true;
  return compareLoc(a.span.start, b.span.end) < 0 && compareLoc(b.span.start, a.span.end) < 0;
}

function compareLoc(a: Loc, b: Loc): number {
  return a.line - b.line || a.col - b.col;
}
