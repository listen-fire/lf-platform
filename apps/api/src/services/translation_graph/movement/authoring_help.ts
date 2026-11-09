// What an agent working on an automation is taught: the help of the
// automation's own language version. The current version's book and catalog
// answer its pins; a carried version's own answer its pins, through its package
// (`@listen-fire/language-versions`), loaded only when such a pin asks; a pin
// nothing teaches is refused, never answered from another version.

import { LANGUAGE_VERSION, languageVersionDiagnostic, type LanguageVersion } from 'movement-lang';
import { helpingOf, isCurrent, type CarriedHandbook, type HelpLane } from '@listen-fire/language-versions';

import type { AutomationsBook } from '../../../lib/knowledge/library';
import type { CatalogAudience } from './audience';

import { deploymentFacts, teamFactsOf } from './carried_check';
import { neverAsAny } from 'movement-engine/public/types';

export type HelpRoute =
  | { kind: 'current'; pin: LanguageVersion }
  | { kind: 'carried'; pin: LanguageVersion; release: LanguageVersion; lane: () => Promise<HelpLane> }
  | { kind: 'refused'; pin: LanguageVersion; error: string };

export function helpRouteOf(pin: LanguageVersion): HelpRoute {
  if (isCurrent(pin)) return { kind: 'current', pin };
  const helping = helpingOf(pin);
  const refusal = languageVersionDiagnostic(pin)?.message ?? `language ${pin} is not one this platform teaches`;
  if (helping === undefined) return { kind: 'refused', pin, error: refusal };
  const { help, release } = helping;
  switch (help.kind) {
    case 'current':
      return { kind: 'current', pin };
    case 'carried':
      return { kind: 'carried', pin, release, lane: help.lane };
    case 'held':
      return { kind: 'refused', pin, error: refusal };
    default:
      return neverAsAny(help);
  }
}

/** Whose help an answer is, for the agent reading it. */
export function languageOf(route: Exclude<HelpRoute, { kind: 'refused' }>, book?: { release: string }) {
  switch (route.kind) {
    case 'current':
      return { version: route.pin, current: true };
    case 'carried':
      return {
        version: route.pin,
        current: false,
        ...(book !== undefined ? { handbook: book.release } : {}),
        note: `This answers for language ${route.pin}, this automation's version; the current version is ${LANGUAGE_VERSION}, and its spellings do not read here.`,
      };
    default:
      return neverAsAny(route);
  }
}

/** A carried version's handbook, for the library's reader. */
export async function carriedAutomationsBook(lane: () => Promise<HelpLane>): Promise<{ book: AutomationsBook; handbook: CarriedHandbook }> {
  const help = await lane();
  const handbook = help.handbookOf(deploymentFacts());
  return {
    handbook,
    book: {
      chapters: handbook.chapters,
      intentIndex: handbook.intentIndex,
      frontPage: handbook.frontPage,
      frontSection: (anchor) => help.handbookFrontSection(anchor),
    },
  };
}

/** The language search of a carried version, over its own book. */
export async function searchCarried(lane: () => Promise<HelpLane>, input: { query: string; kind?: 'function' | 'concept' | 'recipe' }) {
  return (await lane()).searchHandbook(input, deploymentFacts());
}

/** What a request for a micro example answers under a carried version. Handbook
 *  0.12.8 has none (they arrived later), so its own recipes answer instead, and
 *  it says so; a later spelling would not read under the automation's pin. */
export async function exampleUnderCarried(route: Extract<HelpRoute, { kind: 'carried' }>, query: string | undefined): Promise<string> {
  const head = `Language ${route.pin}'s handbook has no micro examples: they arrived in a later release, and their spellings do not read under this automation's version.`;
  if (query === undefined || query.trim() === '') {
    return `${head} Ask with words to search its recipes and concepts, or use searchLanguage with \`automation\`.`;
  }
  const found = await searchCarried(route.lane, { query });
  const results = found.results.map((entry) =>
    [`### ${entry.name}`, entry.purpose, entry.detail, ...(entry.example !== undefined ? ['```', entry.example, '```'] : [])].join('\n'),
  );
  return [`${head} What its language search answers for this:`, ...results, ...(results.length === 0 ? [found.note] : [])].join('\n\n');
}

async function modulePlatformNow() {
  const { modulePlatform } = await import('./carried_run');
  return modulePlatform();
}

/** The catalog view a program on a carried version is written against. */
export async function catalogUnderCarried(lane: () => Promise<HelpLane>, team: { teamId: string; audience: CatalogAudience }) {
  const [help, facts] = await Promise.all([lane(), teamFactsOf(team.teamId, { audience: team.audience })]);
  return help.catalogOf(facts);
}

/** Options a describe takes under the current version that a carried version's
 *  reading does not: it reads a system whole. */
const NOT_CARRIED = ['types', 'position', 'narrow', 'detail'] as const;

/** Systems as compact text, in a carried version's own words. */
export async function describeUnderCarried(
  route: Extract<HelpRoute, { kind: 'carried' }>,
  input: { teamId: string; audience: CatalogAudience; systems: readonly string[]; connection?: string; asked: Partial<Record<(typeof NOT_CARRIED)[number], unknown>> },
): Promise<string> {
  const [help, team, modules] = await Promise.all([route.lane(), teamFactsOf(input.teamId, { audience: input.audience }), modulePlatformNow()]);
  const blocks = await Promise.all(
    input.systems.map((system) =>
      help.describeSystem({
        team,
        teamId: input.teamId,
        modules,
        system,
        ...(input.systems.length === 1 && input.connection !== undefined ? { connection: input.connection } : {}),
      }),
    ),
  );
  const ignored = NOT_CARRIED.filter((option) => input.asked[option] !== undefined);
  const said = [
    `Read for language ${route.pin}, this automation's version: each system whole, through that version's own module.`,
    ...(ignored.length > 0 ? [`${ignored.join(', ')}: not read under ${route.pin} on this platform, so this answer ignores them.`] : []),
  ];
  return [...blocks, said.join(' ')].join('\n\n');
}

/** The first read under a carried version: its systems, as it reads them. */
export async function digestUnderCarried(lane: () => Promise<HelpLane>, asked: { teamId: string; audience: CatalogAudience }): Promise<string> {
  const [help, team, modules] = await Promise.all([lane(), teamFactsOf(asked.teamId, { audience: asked.audience }), modulePlatformNow()]);
  return help.connectionsDigest({ team, teamId: asked.teamId, modules });
}
