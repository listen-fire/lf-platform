// The automations handbook — chapters teaching the automation language AS AN
// AUTHOR, behind a thin index/lookup surface. The chapter bodies are
// consumer-neutral: the same text serves an authoring agent's reference tool,
// an editor's reference panel and the docs site.
//
// This is the language's part of the book: the hand-written chapters, the
// front page, the routes into them and the search over them. A host adds the
// sections its own systems and plugins declare (`system:<adapter>`,
// `plugin:<name>`) and reads the assembled book through `readChapter` and
// `renderIndex`; the routes below already name some of those sections, so a
// host that serves the index serves the sections it routes to.
//
// Language spec: plans/2026-06-10-data-movement-language/3_syntax_sketch.md
// (surface), 1_principles.md (model), 6_engine.md (listen/run semantics).

import type { Chapter, ChapterId, Handbook, IntentEntry } from './types';

import { chapterRoute, sliceChapterSection } from 'engine-contracts/handbook_section';
import { foundations } from './chapters/foundations';
import { anatomy } from './chapters/anatomy';
import { expressions } from './chapters/expressions';
import { writes } from './chapters/writes';
import { traversal } from './chapters/traversal';
import { extraction } from './chapters/extraction';
import { branching } from './chapters/branching';
import { listeners } from './chapters/listeners';
import { asks as reviews } from './chapters/asks';
import { patterns } from './chapters/patterns';
import { useCases } from './chapters/use_cases';
import { runs } from './chapters/runs';
import { reference } from './chapters/reference';
import { builtins } from './chapters/builtins';

export * from './types';
export * from './front_page';
export * from './language_search';
export * from './prose_rules';

/**
 * `foundations#conventions` is a route the index serves and a section every
 * other chapter leans on instead of restating. It is addressed by heading, so
 * renaming the heading would silently unmake the route — checked at import,
 * where a rename fails loudly rather than at whichever fetch first misses.
 */
(function assertConventionsStaysFetchable() {
  const slice = sliceChapterSection(foundations.content, 'conventions');
  if (!slice.ok) {
    throw new Error(`foundations chapter no longer carries a conventions section: ${slice.error}`);
  }
})();

export const INTENT_INDEX: IntentEntry[] = [
  { intent: 'What an automation is, the cardinal rule, reuse vs copy', chapter: 'foundations' },
  { intent: 'What a language version is; moving to the current one', chapter: 'foundations', section: 'language-versions' },
  { intent: 'Start a new automation from a brief', chapter: 'anatomy' },
  { intent: 'React to inbound email or a live event; name listeners', chapter: 'listeners', section: 'listen' },
  { intent: 'Create or update a record in another system', chapter: 'writes', section: 'writes' },
  { intent: 'Stop repeat events making duplicates', chapter: 'writes', section: 'identity' },
  { intent: 'Say if a record was created or updated', chapter: 'writes', section: 'what-the-write-did' },
  { intent: 'Set a field once, never overwrite', chapter: 'writes', section: 'set-if-empty' },
  { intent: 'Add to a multi-value field', chapter: 'writes', section: 'append-to-a-multi-value-field' },
  { intent: 'Find or update a record, never creating', chapter: 'writes', section: 'looking-up-existing-records' },
  { intent: 'Match a record by its identity', chapter: 'writes', section: 'match' },
  { intent: 'Remove a relationship or delete a record', chapter: 'writes', section: 'removal' },
  { intent: 'Create a child record under its parent', chapter: 'writes', section: 'linked-writes' },
  { intent: 'Post to a channel, or reply', chapter: 'writes', section: 'conversation-writes' },
  { intent: "Slack's message field, files, taps, Block Kit", chapter: 'system:slack' },
  { intent: "Telegram's message field, opening a chat, taps", chapter: 'system:telegram' },
  { intent: "WhatsApp's message field, files, taps", chapter: 'system:whatsapp' },
  { intent: 'A mailbox: run on arriving mail, search, send, reply', chapter: 'system:gmail' },
  { intent: 'Create a record with several parents', chapter: 'writes', section: 'multi-parent-writes' },
  { intent: 'Write a nested object or list', chapter: 'writes', section: 'structured-values' },
  { intent: 'Connect a record to one that already exists', chapter: 'writes', section: 'link' },
  { intent: 'Act per attachment or related record, collecting results', chapter: 'traversal', section: 'blocks' },
  { intent: 'Pull records out of text or documents', chapter: 'extraction', section: 'basics' },
  { intent: 'Dealflow mail and decks', chapter: 'use-cases', section: 'dealflow-extraction' },
  { intent: 'Extract records, write them connected', chapter: 'patterns', section: 'extract-and-connect' },
  { intent: 'Enrich extracted records with plugins, then merge', chapter: 'extraction', section: 'enrichment' },
  { intent: 'Load the links in a message', chapter: 'plugin:vc_url_retrieval' },
  { intent: 'What a person or company does, from a name or link', chapter: 'plugin:research' },
  { intent: 'Find a profile address from a name', chapter: 'plugin:research', section: 'what-comes-back' },
  { intent: 'Attach the source files to a written record', chapter: 'extraction', section: 'attaching-the-source-files' },
  { intent: 'Compute one value with judgement', chapter: 'expressions', section: 'ai' },
  { intent: "Today's date, the acting user, a record's owner", chapter: 'expressions', section: 'meta-fields' },
  { intent: 'Only act when a condition holds', chapter: 'branching', section: 'conditions' },
  { intent: 'Narrow a multi-kind source; stop a run', chapter: 'branching', section: 'narrowing' },
  { intent: 'Compose a message quoting earlier writes', chapter: 'expressions', section: 'interpolation' },
  { intent: 'Approve or decide before a write, then resume', chapter: 'reviews', section: 'delivering-and-awaiting' },
  { intent: 'Default or remind if nobody answers; defer', chapter: 'reviews', section: 'timeout-and-escalation' },
  { intent: 'One question to several places', chapter: 'reviews', section: 'several-at-once' },
  { intent: 'A chat button or link that acts and carries a value', chapter: 'reviews', section: 'in-chat-answers' },
  { intent: 'Intake pasted text or a file, reviewed', chapter: 'patterns', section: 'human-reviewed-intake' },
  { intent: 'Send one event to several systems', chapter: 'patterns', section: 'multi-target' },
  { intent: 'Compose a report as a PDF or text file', chapter: 'patterns', section: 'compose-a-report' },
  { intent: 'Scheduled digest: query, compose, post', chapter: 'patterns', section: 'scheduled-digest' },
  { intent: 'Handle a possibly absent field', chapter: 'expressions', section: 'values-that-may-not-be-there' },
  { intent: 'Group, transform, count or total a list', chapter: 'expressions', section: 'iterating-values' },
  { intent: 'Look a value up by name; build named values', chapter: 'expressions', section: 'keyed-values' },
  { intent: 'A report section per value of a type', chapter: 'patterns', section: 'sections-from-a-type' },
  { intent: 'Reuse one automation from another; return a result', chapter: 'anatomy', section: 'composition' },
  { intent: 'Walk a tree or chain by a function calling itself', chapter: 'anatomy', section: 'recursion' },
  { intent: 'Build a record in memory to pass along', chapter: 'anatomy', section: 'records-you-build' },
  { intent: 'Act on everything the run wrote', chapter: 'anatomy', section: 'collect-what-you-wrote' },
  { intent: 'Run ad hoc: pasted text, files, backfills', chapter: 'system:manual' },
  { intent: 'Run on a schedule', chapter: 'system:cron' },
  { intent: 'Run when another automation fails', chapter: 'system:system' },
  { intent: 'Store records in the graph; run on its changes', chapter: 'system:kg' },
  { intent: 'Query a graph: filter, order, take the top N', chapter: 'traversal', section: 'query-a-graph' },
  { intent: 'Relationship order; why a sort is refused', chapter: 'traversal', section: 'record-order' },
  { intent: 'Rehearse an automation before going live', chapter: 'anatomy', section: 'constructions' },
  { intent: 'See what a run did; trace where a value came from', chapter: 'runs', section: 'run-history' },
  { intent: 'What makes a run expensive, and how to cut it', chapter: 'runs', section: 'what-a-run-costs' },
  { intent: 'Operator spelling; when a name needs backticks', chapter: 'reference', section: 'operators-and-functions' },
  { intent: 'Write modifiers, unique-by forms, query clauses', chapter: 'reference', section: 'writes' },
  { intent: 'Common authoring mistakes', chapter: 'reference', section: 'pitfalls' },
];

/** The hand-written chapters, in reading order. */
export const CORE_CHAPTERS: Readonly<Record<ChapterId, Chapter>> = {
  foundations,
  anatomy,
  expressions,
  writes,
  traversal,
  extraction,
  branching,
  listeners,
  reviews,
  patterns,
  'use-cases': useCases,
  runs,
  reference,
  builtins,
};

/** The routes, then the chapters, of `handbook` — what a reader who does not
 *  yet know where to look is handed. */
export function renderIndex(handbook: Handbook): string {
  const intents = handbook.intentIndex.map((e) => `- ${e.intent} → ${chapterRoute(e)}`).join('\n');
  const chapters = Object.values(handbook.chapters)
    .map((c) => `- ${c.id} — ${c.title}`)
    .join('\n');
  return `## Automation authoring handbook — index\n\nA route is a chapter, or \`chapter#section\` — one section of it, which is what to read when you need one rule.\n\nWhen you need to:\n${intents}\n\nChapters (read the relevant one before authoring):\n${chapters}`;
}

/**
 * A chapter of `chapters`, or one `### ` section of it — the unit the intent
 * index points at, so needing one rule costs one rule rather than a whole
 * chapter.
 */
export function readChapter(
  chapters: Readonly<Record<string, Chapter>>,
  id: string,
  section?: string,
): { ok: true; content: string; section?: string } | { ok: false; error: string } {
  const chapter: Chapter | undefined = chapters[id];
  if (!chapter) {
    const available = Object.keys(chapters).join(', ');
    return {
      ok: false,
      error: `No chapter "${id}". Available: ${available}. Ask for the index (no chapter) to see all situations.`,
    };
  }
  if (section === undefined) return { ok: true, content: chapter.content };
  const slice = sliceChapterSection(chapter.content, section);
  if (!slice.ok) return { ok: false, error: `${slice.error} (chapter "${id}")` };
  return { ok: true, content: slice.content, section: slice.section };
}

/** `readChapter` over the hand-written chapters alone. */
export function getCoreChapter(id: string, section?: string): ReturnType<typeof readChapter> {
  return readChapter(CORE_CHAPTERS, id, section);
}

/** `renderIndex` over the hand-written chapters alone; the routes into a
 *  host's sections are listed though no section of a host's is. */
export function renderCoreIndex(): string {
  return renderIndex({ intentIndex: INTENT_INDEX, chapters: CORE_CHAPTERS });
}

/**
 * The portable authoring DOCTRINE — what an automation is, the cardinal
 * "write along edges, never flat rows" rule, the use-cases-first habit,
 * and factor-don't-copy — as one block, sourced from the readable
 * `foundations` chapter. This is the single source of truth: it feeds both
 * the chapter a reader fetches and an authoring agent's system prompt
 * (injected verbatim). Editing the chapter updates both.
 *
 * Deploy-static: the chapter content is a module-level constant, so
 * callers can compute this once at module load and inject it into a
 * cached system block without introducing per-request variability.
 */
export function getMovementDoctrine(): string {
  return foundations.content;
}
