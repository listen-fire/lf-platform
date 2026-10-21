// The automations handbook as this platform serves it: the language's book
// (@listen-fire/handbook — the hand-written chapters, the front page, the
// routes and the search) with the sections this platform's systems and plugins
// declare on their manifests assembled on top, so a system's or a plugin's
// conceptual documentation is owned by the thing itself rather than by a
// second copy here that drifts.

import {
  CORE_CHAPTERS,
  INTENT_INDEX,
  getMovementDoctrine,
  languageIndex as languageIndexOver,
  readChapter,
  renderIndex,
  searchLanguage as searchLanguageOver,
  type Chapter,
  type Handbook,
  type HandbookChapterId,
  type LanguageEntry,
  type LanguageSearchKind,
  type LanguageSearchResult,
  type PluginChapterId,
  type SystemChapterId,
} from '@listen-fire/handbook';
import type { AdapterManifest } from 'movement-engine/public/adapter';
import type { PluginManifest } from '../../../services/translation_graph/engine/transforms/registry';

import { listAdapterManifests } from '../../../services/translation_graph/adapters/registry';

export { LANGUAGE_SEARCH_KINDS, frontSection, getMovementDoctrine, renderFrontPage } from '@listen-fire/handbook';
export type { Chapter, Handbook, HandbookChapterId, LanguageEntry, LanguageSearchKind, LanguageSearchResult } from '@listen-fire/handbook';

/**
 * The sections adapters declare on their manifests, as chapters.
 *
 * Pure over the manifests it is handed, so the guards that hold the
 * hand-written chapters — the prose contract, the engine-claims lockstep, the
 * checker validation — can be run over an arbitrary manifest rather than only
 * over whatever happens to be registered.
 */
export function adapterSectionChapters(manifests: readonly AdapterManifest[]): Chapter[] {
  return manifests.flatMap((manifest) => {
    const section = manifest.handbookSection;
    if (!section) return [];
    const id: SystemChapterId = `system:${manifest.adapterType}`;
    return [
      {
        id,
        title: section.title,
        content: section.content,
        ...(section.engineClaims ? { engineClaims: section.engineClaims } : {}),
      },
    ];
  });
}

/**
 * The sections plugins declare on their manifests, as chapters — the same
 * mechanism as `adapterSectionChapters`, in its own namespace because a plugin
 * is a function an extraction calls, not a system to connect.
 *
 * Keyed by the name a program imports the plugin under, so the route an author
 * is pointed at is spelled the way they write the call.
 */
export function pluginSectionChapters(manifests: readonly PluginManifest[]): Chapter[] {
  return manifests.flatMap((manifest) => {
    const section = manifest.handbookSection;
    if (!section) return [];
    const id: PluginChapterId = `plugin:${manifest.importName}`;
    return [
      {
        id,
        title: section.title,
        content: section.content,
        ...(section.engineClaims ? { engineClaims: section.engineClaims } : {}),
      },
    ];
  });
}

/** The bundled plugin manifests, required lazily: the plugin modules pull in
 *  the model and scraper service chain, which must not load merely because
 *  something imported the handbook. */
function bundledPluginManifests(): PluginManifest[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod =
    require('../../../services/translation_graph/engine/transforms/register-bundled') as typeof import('../../../services/translation_graph/engine/transforms/register-bundled');
  return mod.listPluginManifests();
}

/**
 * Built fresh per call, mirroring `getUsingListenFireHandbook()`: the hand-written
 * chapters, one chapter per adapter that declares a section, and one per
 * plugin that declares a section.
 */
export function getMovementHandbook(): Handbook {
  const chapters: Record<HandbookChapterId, Chapter> = { ...CORE_CHAPTERS };
  for (const section of adapterSectionChapters(listAdapterManifests())) {
    chapters[section.id] = section;
  }
  for (const section of pluginSectionChapters(bundledPluginManifests())) {
    chapters[section.id] = section;
  }
  return {
    intentIndex: INTENT_INDEX,
    chapters,
  };
}

export function renderMovementIndex(): string {
  return renderIndex(getMovementHandbook());
}

/**
 * A chapter, or one `### ` section of it — the unit the intent index points
 * at, so needing one rule costs one rule rather than a whole chapter.
 */
export function getMovementChapter(id: string, section?: string): ReturnType<typeof readChapter> {
  return readChapter(getMovementHandbook().chapters, id, section);
}

/**
 * What a consumer is handed before it reads anything else: the model card,
 * then the routes. Foundations IS the front matter — one copy of the model,
 * the cardinal rule, and the conventions, whether it arrives here or as a
 * chapter fetch.
 */
export function buildMovementFrontMatter(): string {
  return `${getMovementDoctrine()}\n\n${renderMovementIndex()}`;
}

/** The language search over the book as assembled here, so a system's and a
 *  plugin's sections are found beside the core chapters. */
export function languageIndex(): LanguageEntry[] {
  return languageIndexOver(getMovementHandbook().chapters);
}

/** The best few entries for `query` over the assembled book, optionally of one kind. */
export function searchLanguage(input: { query: string; kind?: LanguageSearchKind }): LanguageSearchResult {
  return searchLanguageOver(input, getMovementHandbook().chapters);
}
