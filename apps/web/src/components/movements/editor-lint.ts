/**
 * Which checker the editor's lint asks, and how a server answer lands in it.
 *
 * A legacy pin ('1'..'4') is checked in the browser by legacy-lang. A release
 * pin is the wasm checker's, against the run snapshot, and that checker is not
 * in the browser, so its lint is the server's `views.movement.check`. A pin
 * nothing reads goes to the server too, which answers with the version
 * diagnostic every other surface reports for it.
 *
 * Completions, hover and definition follow the same route: legacy-lang in the
 * browser for a legacy pin, the server's language service for a release pin
 * (./editor-language.ts), and nothing for a pin nothing reads.
 */

import type { MovementDiagnostic } from "legacy-lang";

/** The server's account of a pin (`views.movement.get`'s `languageRoute`,
 *  `views.movement.catalog`'s `installed` for a new movement). */
export interface EditorLanguageRoute {
  kind: "legacy" | "installed" | "refused";
}

/** A diagnostic as the server reports it: 1-based line/col. */
export interface RemoteDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

/** The server's lint for `source`; `signal` aborts a superseded request. */
export type CheckRemote = (source: string, signal: AbortSignal) => Promise<RemoteDiagnostic[]>;

export function lintsInBrowser(route: EditorLanguageRoute): boolean {
  return route.kind === "legacy";
}

export function remoteToEditorDiagnostics(
  source: string,
  remote: RemoteDiagnostic[],
): MovementDiagnostic[] {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const offsetOf = (line: number, col: number): number => {
    const lineStart = lineStarts[Math.min(Math.max(line, 1), lineStarts.length) - 1] ?? 0;
    return Math.min(Math.max(lineStart + col - 1, 0), source.length);
  };
  return remote.map((d) => {
    const from = offsetOf(d.line, d.col);
    let to = offsetOf(d.endLine, d.endCol);
    // The same widening the browser's lint applies: a zero-width span covers
    // the word at `from`, so the squiggle is visible.
    if (to <= from) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(from));
      to = Math.min(from + (word ? word[0].length : 1), source.length);
    }
    return {
      code: d.code,
      message: d.message,
      severity: d.severity,
      span: { start: { line: d.line, col: d.col }, end: { line: d.endLine, col: d.endCol } },
      from,
      to,
    };
  });
}
