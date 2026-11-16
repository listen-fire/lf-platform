// A 0.15 program's picture, from one call into 0.15's language: its story
// analysis is the check's own walk, so the verdict the picture carries and the
// picture cannot disagree (production's `story_from_analysis.ts` at 0.15.3).
// It is drawn against the snapshot the check reads, and comes back as plain
// data with the words its systems declare, so the platform's join reads
// nothing of this release.

import { RustCheckRefused, diagnosticSeverity, storyAnalysisInRust, type Diagnostic } from '@listen-fire/movement-lang';
import type { AdapterManifest } from '@listen-fire/engine/public/adapter';

import { gapsOf } from '../catalog';
import { readProgram } from '../check';
import type { CheckGap, CheckRequest, CheckedDiagnostic } from '../types';
import { analysisFacts } from './analysis_facts';
import { projectStoryFrom, type StoryIR, type StoryProblem, type StoryValidityStatus } from './story';

/** The words a program's systems declare, as the platform's join reads them. */
export interface StoryWords {
  systems: Record<
    string,
    {
      label: string;
      icon: NonNullable<NonNullable<AdapterManifest['vocabulary']>['icon']> | null;
      eventPhrase?: NonNullable<AdapterManifest['vocabulary']>['eventPhrase'];
    }
  >;
  /** What an instance schema calls a record type, by `<adapter>::<type>`. */
  recordLabels: Record<string, string>;
}

export interface StoryRequest extends CheckRequest {
  name: string;
  /** The platform's stored ruling on the program, carried in as production
   *  carried it: it knows what the checker cannot see. */
  validityStatus?: StoryValidityStatus;
}

export type CarriedStory =
  | { ok: true; story: StoryIR; words: StoryWords; gaps: CheckGap[] }
  | { ok: false; problems: StoryProblem[] };

function wordsOf(manifests: readonly AdapterManifest[], recordLabels: ReadonlyMap<string, string>): StoryWords {
  return {
    systems: Object.fromEntries(
      manifests.map((manifest) => [
        manifest.adapterType,
        {
          label: manifest.displayName,
          icon: manifest.vocabulary?.icon ?? null,
          ...(manifest.vocabulary?.eventPhrase !== undefined ? { eventPhrase: manifest.vocabulary.eventPhrase } : {}),
        },
      ]),
    ),
    recordLabels: Object.fromEntries(recordLabels),
  };
}

function asDiagnostic(diagnostic: CheckedDiagnostic): Diagnostic {
  return { code: diagnostic.code, message: diagnostic.message, span: diagnostic.span };
}

const AT_START = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

export async function storyOf(request: StoryRequest): Promise<CarriedStory> {
  const read = await readProgram(request);
  if (!read.readable) {
    const { code, message, severity, span } = read.refusal;
    return { ok: false, problems: [{ code, message, severity, span }] };
  }
  const { program, closure, libraries, teamCatalog } = read;
  let analysis;
  try {
    analysis = storyAnalysisInRust(request.source, teamCatalog.snapshot, { languageVersion: request.pin });
  } catch (error) {
    if (!(error instanceof RustCheckRefused)) throw error;
    return { ok: false, problems: [{ code: 'MOV_PARSE', message: error.message, severity: 'error', span: AT_START }] };
  }
  // A pin this release does not read is analysed into nothing but its version
  // diagnostic; an empty picture would read as a movement that does nothing.
  if (analysis.scopes.length === 0) {
    return {
      ok: false,
      problems: analysis.diagnostics.map((d) => ({ code: d.code, message: d.message, severity: diagnosticSeverity(d), span: d.span })),
    };
  }
  const gaps = gapsOf([program, ...libraries], teamCatalog);
  // A program with nothing stored on it is as verified as this reading was: a
  // system it could not read is never clean.
  const validityStatus = request.validityStatus ?? (gaps.length > 0 ? 'unverified' : undefined);
  const story = projectStoryFrom(analysisFacts(analysis, program, request.pin), {
    program,
    diagnostics: [...closure.diagnostics.map(asDiagnostic), ...analysis.diagnostics],
    name: request.name,
    ...(validityStatus !== undefined ? { validityStatus } : {}),
  });
  return { ok: true, story, words: wordsOf(teamCatalog.manifests, teamCatalog.recordLabels), gaps };
}
