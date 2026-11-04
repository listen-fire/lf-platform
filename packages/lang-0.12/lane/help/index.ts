// Authoring help for a 0.12 program, in 0.12's own words: handbook 0.12.8 with
// the sections 0.12's modules and plugins declared, the language search over
// that book, and 0.12's catalog of systems. An agent working on a 0.12
// automation is taught what 0.12's checker will read, never a later spelling.
//
// The assembly is what production's `lib/knowledge/movement_handbook` did at
// 0.12.13.

import { readFileSync } from 'node:fs';

import {
  CORE_CHAPTERS,
  INTENT_INDEX,
  frontSection,
  renderFrontPage,
  searchLanguage as searchOver,
  type Chapter,
  type HandbookChapterId,
  type LanguageSearchKind,
  type LanguageSearchResult,
} from '@listen-fire/handbook';
import type { HandbookSection } from '@listen-fire/engine/public/handbook';

import { manifestsOf, type DeploymentFacts } from '../manifests';
import { FETCH_URL_HANDBOOK_SECTION } from './fetch_url_handbook_section';
import { LINKEDIN_RESEARCH_HANDBOOK_SECTION } from './linkedin_research_handbook_section';
import { RESEARCH_HANDBOOK_SECTION } from './research_handbook_section';
import { VC_URL_RETRIEVAL_HANDBOOK_SECTION } from './vc_url_retrieval_handbook_section';
import { WEB_RESEARCH_HANDBOOK_SECTION } from './web_research_handbook_section';

export { catalogOf, connectionsDigest, describeSystem } from './connections';

/** The sections the platform's plugins declared at 0.12.13, by the name a
 *  program imports each under. */
const PLUGIN_SECTIONS: Readonly<Record<string, HandbookSection>> = {
  vcUrlRetrieval: VC_URL_RETRIEVAL_HANDBOOK_SECTION,
  fetchUrl: FETCH_URL_HANDBOOK_SECTION,
  linkedinResearch: LINKEDIN_RESEARCH_HANDBOOK_SECTION,
  webResearch: WEB_RESEARCH_HANDBOOK_SECTION,
  research: RESEARCH_HANDBOOK_SECTION,
};

function assembled(deployment: DeploymentFacts): Record<HandbookChapterId, Chapter> {
  const chapters: Record<HandbookChapterId, Chapter> = { ...CORE_CHAPTERS };
  for (const manifest of manifestsOf(deployment)) {
    const section = manifest.handbookSection;
    if (section === undefined) continue;
    const id = `system:${manifest.adapterType}` as const;
    chapters[id] = { id, title: section.title, content: section.content };
  }
  for (const [importName, section] of Object.entries(PLUGIN_SECTIONS)) {
    const id = `plugin:${importName}` as const;
    chapters[id] = { id, title: section.title, content: section.content };
  }
  return chapters;
}

function handbookRelease(): string {
  const manifest: unknown = JSON.parse(readFileSync(require.resolve('@listen-fire/handbook/package.json'), 'utf8'));
  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string') return manifest.version;
  throw new Error("@listen-fire/handbook's package.json names no version");
}

/** The book as this version serves it: plain text, for the platform's reader. */
export function handbookOf(deployment: DeploymentFacts) {
  return {
    release: handbookRelease(),
    frontPage: renderFrontPage(),
    chapters: Object.values(assembled(deployment)).map((chapter) => ({ id: chapter.id, title: chapter.title, content: chapter.content })),
    intentIndex: INTENT_INDEX.map((entry) => ({
      intent: entry.intent,
      chapter: entry.chapter,
      ...(entry.section !== undefined ? { section: entry.section } : {}),
    })),
  };
}

/** One entry of the front page by its anchor (`front#maybe-absent`). */
export function handbookFrontSection(anchor: string) {
  return frontSection(anchor);
}

/** The best few entries for `query` over the assembled book. */
export function searchHandbook(input: { query: string; kind?: LanguageSearchKind }, deployment: DeploymentFacts): LanguageSearchResult {
  return searchOver(input, assembled(deployment));
}
