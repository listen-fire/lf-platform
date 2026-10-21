// The checker's diagnostic: what a check reports, wherever the check ran.

import type { Span } from '../parser/ast';
import type { DiagnosticFix } from './fixes';


export type DiagnosticSeverity = 'error' | 'warning' | 'info';


export interface Diagnostic {
  code: string;
  message: string;
  span: Span;
  /** Absent means 'error'. 'warning' and 'info' diagnostics never gate a
   *  compile — warnings flag likely-unintended-but-legal authoring. */
  severity?: DiagnosticSeverity;
  /** Set on a diagnostic the checker emits only BECAUSE this is a check for a
   *  move up (`CheckOptions.upgradingFrom`): it marks a construct whose
   *  meaning changed between the two versions. What keeps a pin where it is,
   *  alongside errors — every other warning (a cost note, say) reads the same
   *  under either version and says nothing about the move. */
  upgrade?: true;
  /** The exact rewrite that resolves it, built from the author's own source —
   *  also spelled out in `message`, which is all a text reader sees. */
  fix?: DiagnosticFix;
}


export function diagnosticSeverity(diagnostic: Diagnostic): DiagnosticSeverity {
  return diagnostic.severity ?? 'error';
}
