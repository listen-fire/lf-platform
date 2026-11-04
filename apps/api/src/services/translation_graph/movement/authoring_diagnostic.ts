// A checker's diagnostic in the authoring shape. Its severity is the one the
// diagnostic carries, so a carried version's diagnostic keeps its own
// release's severity (./carried_check.ts), never re-derived by this one's.

import { diagnosticSeverity, type Diagnostic, type Span } from 'movement-lang';

import type { AuthoringDiagnostic } from './authoring';

export function toAuthoringDiagnostic(
  diagnostic: Diagnostic,
  lines: string[],
): AuthoringDiagnostic {
  const span: Span = diagnostic.span;
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic),
    line: span.start.line,
    col: span.start.col,
    endLine: span.end.line,
    endCol: span.end.col,
    sourceLine: lines[span.start.line - 1] ?? '',
    ...(diagnostic.upgrade === true ? { upgrade: true } : {}),
    ...(diagnostic.fix !== undefined
      ? {
          fix: {
            edits: diagnostic.fix.edits.map((edit) => ({
              line: edit.span.start.line,
              col: edit.span.start.col,
              endLine: edit.span.end.line,
              endCol: edit.span.end.col,
              text: edit.text,
            })),
            ...(diagnostic.fix.safe === true ? { safe: true as const } : {}),
          },
        }
      : {}),
  };
}

/** Each diagnostic once: the same code, place and message reported twice is one. */
export function dedupeDiagnostics<D extends Diagnostic>(diagnostics: readonly D[]): D[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.code}@${d.span.start.line}:${d.span.start.col}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

