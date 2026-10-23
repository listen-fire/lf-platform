// The story of a release pin, from one call into the language: its story
// analysis is the check's own walk, so the verdict the story carries and the
// picture it draws come from the same answer and cannot disagree.

import {
  RustCheckRefused,
  diagnosticSeverity,
  parseProgram,
  storyAnalysisInRust,
  type CatalogSnapshot,
  type Diagnostic,
  type LanguageVersion,
} from 'movement-lang';
import { projectStoryFrom, type StoryResult, type StoryValidityStatus } from 'legacy-lang';

import { analysisFacts } from './story_analysis_facts';

export function storyFromAnalysis(input: {
  source: string;
  snapshot: CatalogSnapshot;
  pin: LanguageVersion;
  name?: string;
  validityStatus?: StoryValidityStatus;
}): { result: StoryResult; diagnostics: Diagnostic[] } {
  let analysis;
  try {
    analysis = storyAnalysisInRust(input.source, input.snapshot, { languageVersion: input.pin });
  } catch (error) {
    if (!(error instanceof RustCheckRefused)) throw error;
    // As `checkInstalled` reports a source the artifact will not read.
    const diagnostic: Diagnostic = {
      code: 'MOV_PARSE',
      message: error.message,
      span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
    };
    return { result: unreadable([diagnostic]), diagnostics: [diagnostic] };
  }
  // A pin this release does not read is analysed into nothing but its version
  // diagnostic; an empty picture would read as a movement that does nothing.
  // A read analysis always has the file's scope.
  if (analysis.scopes.length === 0) {
    return { result: unreadable(analysis.diagnostics), diagnostics: analysis.diagnostics };
  }
  const program = parseProgram(input.source, { languageVersion: input.pin });
  const story = projectStoryFrom(analysisFacts(analysis, program, input.pin), {
    program,
    diagnostics: analysis.diagnostics,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.validityStatus !== undefined ? { validityStatus: input.validityStatus } : {}),
  });
  return { result: { ok: true, story }, diagnostics: analysis.diagnostics };
}

function unreadable(diagnostics: Diagnostic[]): StoryResult {
  return {
    ok: false,
    reason: 'unparseable',
    problems: diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
      severity: diagnosticSeverity(d),
      span: d.span,
    })),
  };
}
