// linkedin-research — the plugin that starts from a profile address.
//
// Every external edge is mocked (the search index, the two model calls, the
// page fetch, the profile service), so what is under test is the plugin's own
// contract: which steps run, in what order, what the budget stops, and when it
// attaches nothing at all.
//
// No real person's address or name appears here — the slugs are obvious
// fakes, which is also what makes the acceptance-rule cases readable.
//
// Contract: plans/linkedin-research-plugin-2026-09-03/1_contract.md

// ── External dependency mocks (hoisted above the imports) ─────────────────

const mockAnthropicChat = jest.fn();
const mockAnthropicChatStructured = jest.fn();
const mockSearch = jest.fn();
const mockFetchWithTimeout = jest.fn();
const mockGetProfileTextByUrl = jest.fn();
const mockIsSupportedUrl = jest.fn();

jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: (...args: unknown[]) => mockAnthropicChat(...args),
  anthropicChatStructured: (...args: unknown[]) => mockAnthropicChatStructured(...args),
}));
jest.mock('../../../lib/prompts/execute', () => ({
  parseJson: (raw: string) => JSON.parse(raw),
}));
// The document store reaches Playwright, the crawler and the prompt library;
// all the plugin asks it is whether an address is a document.
jest.mock('../../../lib/document_sources', () => ({
  DocumentSourceService: {
    isSupportedUrl: (...args: unknown[]) => mockIsSupportedUrl(...args),
  },
}));
jest.mock('../../web_search', () => ({
  WebSearchService: {
    search: (...args: unknown[]) => mockSearch(...args),
  },
}));
// The shared fetch plumbing reaches the scraper, the document store and the
// database; the plugin only wants the text back, so the whole module is
// stood in for.
jest.mock('../engine/transforms/fetch_resource', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
  describeError: (e: unknown) => String(e),
}));

// ── Module imports (after mocks) ──────────────────────────────────────────

import type { ContextDependentInput } from '../engine/transforms';
import type { SourcePosition } from 'engine-contracts/catalog';

import {
  linkedinResearchImpl,
  LINKEDIN_RESEARCH_PLUGIN_MANIFEST,
} from '../engine/transforms/linkedin-research';
import { services } from '../../../adapters/registry';
import { makeStablePosition } from 'engine-contracts/catalog';
import { captureEngineLogs } from '../../../test/engine_logs';

// ── Fixtures ──────────────────────────────────────────────────────────────

const PROFILE_URL = 'https://www.linkedin.com/in/example-person-1234/';
const PROFILE_LINK = 'https://www.linkedin.com/in/example-person-1234';
/** The first thing asked of the index: the site query finds the profile far
 *  more often than the bare address, which is only the second try. */
const SITE_QUERY = 'site:linkedin.com/in/example-person-1234';

const sourceNode: SourcePosition = makeStablePosition({
  adapterType: 'fixture',
  recordType: 'fixture.message',
  recordId: 'msg-1',
  data: {},
});

function invoke(config: Record<string, unknown>, extractedContext: unknown = {}) {
  const input: ContextDependentInput = {
    kind: 'context-dependent',
    sourceNode,
    config,
    extractedContext,
  };
  return linkedinResearchImpl.run(input);
}

/** The index result for the address itself — a rich LinkedIn title, which is
 *  what makes the profile service unnecessary. */
const RICH_INDEX_RESULT = {
  items: [
    {
      link: PROFILE_LINK,
      title: 'Alex Example - Head of Platform - Northwind Labs | LinkedIn',
      snippet: 'Head of Platform at Northwind Labs. Berlin.',
    },
  ],
};

/** A title with nothing after the name: no role, no organisation, nothing for
 *  the acceptance rule to check against. */
const THIN_INDEX_RESULT = {
  items: [{ link: PROFILE_LINK, title: 'Alex Example | LinkedIn', snippet: 'LinkedIn' }],
};

const ACTIVITY_RESULT = {
  items: [
    {
      link: 'https://news.example.com/northwind-launch',
      title: 'Northwind Labs launches its platform',
      snippet: 'Alex Example, Head of Platform at Northwind Labs, said…',
    },
  ],
};

const PLAN_REPLY = JSON.stringify({
  queries: [
    { query: '"Alex Example" Northwind Labs', worth_reading: true },
    { query: '"Alex Example" podcast', worth_reading: false },
  ],
  terms: ['Northwind Labs', 'Berlin'],
  tied_down: true,
});

/** A planner that found nothing in what it was given to tie the person down. */
const UNTIED_PLAN_REPLY = JSON.stringify({
  queries: [{ query: '"Alex Example" interview', worth_reading: false }],
  terms: [],
  tied_down: false,
});

/** The synthesiser answers through a forced tool call, so its reply is an
 *  object rather than text to parse. */
const SYNTHESIS_REPLY = {
  found: true,
  confidence: 'high',
  current_role: 'Head of Platform',
  current_organisation: 'Northwind Labs',
  summary: 'Runs platform at Northwind Labs and launched it in June [1].',
  sources: ['https://news.example.com/northwind-launch', PROFILE_LINK],
};

const NOTHING_CONSISTENT = {
  found: false,
  confidence: 'low',
  current_role: '',
  current_organisation: '',
  summary: '',
  sources: [],
};

/** Say what each model call replied, rather than counting calls. */
function replies({ plan, synthesis }: { plan?: string; synthesis?: unknown }) {
  mockAnthropicChat.mockResolvedValue(plan ?? '{}');
  mockAnthropicChatStructured.mockResolvedValue(synthesis ?? NOTHING_CONSISTENT);
}

const logs = captureEngineLogs();

beforeEach(() => {
  mockAnthropicChat.mockReset();
  mockAnthropicChatStructured.mockReset();
  mockSearch.mockReset();
  mockFetchWithTimeout.mockReset();
  mockGetProfileTextByUrl.mockReset();
  mockIsSupportedUrl.mockReset();
  mockIsSupportedUrl.mockReturnValue(false);
  services.linkedin = undefined;
  mockFetchWithTimeout.mockResolvedValue(null);
});

// ── The signature ─────────────────────────────────────────────────────────

describe('linkedin-research signature', () => {
  it('declares a required url, an optional context, and the six properties it attaches', () => {
    const sig = linkedinResearchImpl.signature;
    expect(sig.name).toBe('linkedin-research');
    expect(sig.dataDependency).toBe('extracted_context');
    expect(sig.effects).toEqual({ reads: ['the web'], ai: true });

    const url = sig.params.find((p) => p.name === 'url');
    expect(url?.required).toBe(true);
    expect(url?.type.kind).toBe('string');

    const context = sig.params.find((p) => p.name === 'context');
    expect(context?.required).not.toBe(true);
    expect(context?.type.kind).toBe('string');

    expect(Object.keys(sig.additions.properties ?? {}).sort()).toEqual([
      'activity_confidence',
      'activity_sources',
      'activity_summary',
      'activity_text',
      'current_organisation',
      'current_role',
    ]);
  });

  it('is imported as linkedin_research', () => {
    expect(LINKEDIN_RESEARCH_PLUGIN_MANIFEST.importName).toBe('linkedin_research');
    expect(LINKEDIN_RESEARCH_PLUGIN_MANIFEST.displayName).toBe('LinkedIn activity');
  });
});

// ── The address ───────────────────────────────────────────────────────────

describe('the address is the anchor', () => {
  it.each([
    ['a company page', 'https://www.linkedin.com/company/northwind'],
    ['a bare name', 'Alex Example'],
    ['nothing at all', ''],
    ['not a string', 42],
  ])('attaches nothing when the url is %s', async (_case, url) => {
    expect(await invoke({ url })).toEqual({});
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockAnthropicChat).not.toHaveBeenCalled();
  });

  it.each([
    ['no scheme', 'linkedin.com/in/example-person-1234'],
    ['a country subdomain', 'https://de.linkedin.com/in/example-person-1234'],
    ['a trailing path and query', 'https://www.linkedin.com/in/example-person-1234/?trk=abc'],
  ])('researches an address written with %s', async (_case, url) => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url });
    expect(out.properties?.activity_confidence).toBe('high');
  });
});

// ── Identity ──────────────────────────────────────────────────────────────

describe('identity', () => {
  it('skips the profile service when the index snippet is rich', async () => {
    services.linkedin = { getProfileTextByUrl: mockGetProfileTextByUrl };
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });
    expect(mockGetProfileTextByUrl).not.toHaveBeenCalled();
  });

  it('reads the profile when the index snippet is thin and the service is there', async () => {
    services.linkedin = { getProfileTextByUrl: mockGetProfileTextByUrl };
    mockGetProfileTextByUrl.mockResolvedValue({
      text: 'Alex Example\nHead of Platform at Northwind Labs\nBerlin',
    });
    mockSearch.mockResolvedValueOnce(THIN_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    // The paid read is the last resort: it runs because the planner could find
    // nothing to tie the person down, not because the title was thin.
    replies({ plan: UNTIED_PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL });
    expect(mockGetProfileTextByUrl).toHaveBeenCalledWith(
      PROFILE_LINK,
      expect.objectContaining({ maxWaitMs: expect.any(Number) }),
    );
    expect(out.properties?.activity_summary).toBeDefined();
  });

  it('does not read the profile on a thin snippet when the planner says something ties the person down', async () => {
    services.linkedin = { getProfileTextByUrl: mockGetProfileTextByUrl };
    mockSearch.mockResolvedValueOnce(THIN_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });
    expect(mockGetProfileTextByUrl).not.toHaveBeenCalled();
  });

  it('does not ask the writer to choose among namesakes when the title is thin and nothing ties the person down', async () => {
    mockSearch.mockResolvedValueOnce(THIN_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: UNTIED_PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    // Only the name could connect a result to this person.
    expect(await invoke({ url: PROFILE_URL })).toEqual({});
    expect(mockAnthropicChatStructured).not.toHaveBeenCalled();
  });

  it('caps the confidence at low when nothing ties the person down and no profile was read', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: UNTIED_PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL });
    // The synthesiser said `high`; a person nothing tied down was searched for
    // on a name alone, which cannot support more than a hedge.
    expect(out.properties?.activity_confidence).toBe('low');
  });

  it('keeps the writer\'s confidence on a thin snippet when the planner ties the person down', async () => {
    mockSearch.mockResolvedValueOnce(THIN_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL });
    expect(out.properties?.activity_confidence).toBe('high');
  });

  it('asks the index about the bare address when the site query returns somebody else', async () => {
    mockSearch
      .mockResolvedValueOnce({
        items: [{ link: 'https://www.linkedin.com/in/someone-else-9999', title: 'Someone Else' }],
      })
      .mockResolvedValueOnce(RICH_INDEX_RESULT)
      .mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL });
    expect(mockSearch.mock.calls[0][0]).toBe(SITE_QUERY);
    expect(mockSearch.mock.calls[1][0]).toBe(PROFILE_LINK);
    expect(out.properties?.current_organisation).toBe('Northwind Labs');
  });

  it('attaches nothing when the index knows the address and no service can help', async () => {
    mockSearch.mockResolvedValue({ items: [] });

    expect(await invoke({ url: PROFILE_URL })).toEqual({});
    // Two identity searches, then it gives up before spending a model call.
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockAnthropicChat).not.toHaveBeenCalled();
  });
});

describe('what the caller already knows', () => {
  it('goes to the planner as steering text and never to the writer', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL, context: 'Alex joined the thread about the Northwind rollout' });

    const planned = mockAnthropicChat.mock.calls[0][0] as { userMessage: string };
    expect(planned.userMessage).toContain('it steers the searches, it is not evidence');
    expect(planned.userMessage).toContain('Alex joined the thread about the Northwind rollout');
    const written = mockAnthropicChatStructured.mock.calls[0][0] as { userMessage: string };
    expect(written.userMessage).not.toContain('Alex joined the thread');
  });

  it('is cut to what a cheap planner call should carry', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL, context: 'x'.repeat(5000) });

    const planned = mockAnthropicChat.mock.calls[0][0] as { userMessage: string };
    expect(planned.userMessage).toContain('x'.repeat(2000));
    expect(planned.userMessage).not.toContain('x'.repeat(2001));
  });

  it('is never what names the person: with no name from the index or the profile, nothing is planned', async () => {
    services.linkedin = { getProfileTextByUrl: mockGetProfileTextByUrl };
    mockGetProfileTextByUrl.mockResolvedValue(null);
    mockSearch.mockResolvedValue({ items: [] });
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    expect(await invoke({ url: PROFILE_URL, context: 'Alex Example, Head of Platform at Northwind Labs' })).toEqual({});
    expect(mockAnthropicChat).not.toHaveBeenCalled();
  });
});

describe('the hosted profile reader\'s labelled form', () => {
  it('gives the name and the headline without their labels, when the index found nobody', async () => {
    services.linkedin = { getProfileTextByUrl: mockGetProfileTextByUrl };
    mockGetProfileTextByUrl.mockResolvedValue({
      text: 'Name: Alex Example\nPosition: Head of Platform at Northwind Labs\nCity: Berlin',
    });
    mockSearch.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [] }).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });

    const planned = mockAnthropicChat.mock.calls[0][0] as { userMessage: string };
    expect(planned.userMessage).toContain('Name: Alex Example\nHeadline: Head of Platform at Northwind Labs');
  });

  it('leaves the headline absent when the record has no Position line, rather than taking the next line', async () => {
    services.linkedin = { getProfileTextByUrl: mockGetProfileTextByUrl };
    mockGetProfileTextByUrl.mockResolvedValue({ text: 'Name: Alex Example\nCity: Berlin' });
    mockSearch.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [] }).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });

    const planned = mockAnthropicChat.mock.calls[0][0] as { userMessage: string };
    expect(planned.userMessage).toContain('Name: Alex Example\nHeadline: unknown');
  });
});

// ── Budget ────────────────────────────────────────────────────────────────

describe('the budget', () => {
  it('runs two activity queries however many the planner returns', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({
        plan: JSON.stringify({
          // Each names the person, which is what a query has to do to be run
          // at all.
          queries: [
            '"Alex Example" q1',
            '"Alex Example" q2',
            '"Alex Example" q3',
          ],
          terms: ['Northwind Labs'],
        }),
        synthesis: SYNTHESIS_REPLY,
      });

    await invoke({ url: PROFILE_URL });
    // 1 identity + 2 activity. The results name the person with a term, so
    // there is no retry, and they name the organisation, so no expansion.
    expect(mockSearch).toHaveBeenCalledTimes(3);
    const queries = mockSearch.mock.calls.map((c) => c[0]);
    expect(queries.slice(1)).toEqual(['"Alex Example" q1', '"Alex Example" q2']);
  });

  it('spends the fourth search on one retry when the first two found nobody, and none on the organisation', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({ items: [] });
    // The first plan, then the retry's reply, which writes one different query.
    mockAnthropicChat
      .mockResolvedValueOnce(
        JSON.stringify({ queries: ['"Alex Example" q1', '"Alex Example" q2'], terms: ['Northwind Labs'], tied_down: true }),
      )
      .mockResolvedValueOnce(JSON.stringify({ queries: ['"Alex Example" q3'] }));
    mockAnthropicChatStructured.mockResolvedValue(SYNTHESIS_REPLY);

    await invoke({ url: PROFILE_URL });
    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    expect(queries).toEqual([SITE_QUERY, '"Alex Example" q1', '"Alex Example" q2', '"Alex Example" q3']);
    expect(queries.some((q) => q.includes('site:crunchbase.com'))).toBe(false);
  });

  it('skips the organisation search when the activity search already named the organisation', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });
    // 1 identity + 2 activity; the activity results name Northwind Labs.
    expect(mockSearch).toHaveBeenCalledTimes(3);
    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    expect(queries.some((q) => q.includes('site:crunchbase.com'))).toBe(false);
  });

  it('reads at most two pages, and never a LinkedIn one', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({
      items: [
        { link: 'https://www.linkedin.com/posts/example-person-1234_a-post', title: 'A post' },
        { link: 'https://a.example.com/one', title: 'Northwind Labs one' },
        { link: 'https://b.example.com/two', title: 'Northwind Labs two' },
        { link: 'https://c.example.com/three', title: 'Northwind Labs three' },
      ],
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'page text' });
    replies({
        plan: JSON.stringify({
          queries: [{ query: '"Alex Example" q1', worth_reading: true }],
          terms: ['Northwind Labs'],
        }),
        synthesis: SYNTHESIS_REPLY,
      });

    await invoke({ url: PROFILE_URL });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    const fetched = mockFetchWithTimeout.mock.calls.map((c) => c[0]);
    expect(fetched).toEqual(['https://a.example.com/one', 'https://b.example.com/two']);
  });

  it('degrades rather than throwing when the index fails', async () => {
    mockSearch.mockRejectedValue(new Error('search is down'));

    expect(await invoke({ url: PROFILE_URL })).toEqual({});
  });
});

// ── Only distinctive things are searched for, or read ─────────────────────

/** "Stealth Startup" is where an employer's name would go, and is thousands of
 *  unrelated people's answer to the same question. */
const STEALTH_INDEX_RESULT = {
  items: [
    {
      link: PROFILE_LINK,
      title: 'Alex Example - Founder - Stealth Startup | LinkedIn',
      snippet: 'Founder at Stealth Startup. Berlin.',
    },
  ],
};

describe('the distinctiveness gate', () => {
  it('never anchors a search on a placeholder organisation', async () => {
    mockSearch.mockResolvedValueOnce(STEALTH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
      plan: JSON.stringify({
        queries: [
          { query: '"Alex Example" founder', worth_reading: true },
          { query: '"Stealth Startup" funding', worth_reading: true },
        ],
        terms: ['Stealth Startup', 'Berlin'],
        organisation: 'Stealth Startup',
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });

    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    // One identity search and one activity query: the placeholder query is
    // dropped and the aggregator expansion never runs.
    expect(queries).toEqual([SITE_QUERY, '"Alex Example" founder']);
    expect(queries.some((q) => q.includes('site:crunchbase.com'))).toBe(false);
    expect(queries.some((q) => q.toLowerCase().includes('stealth'))).toBe(false);
    // Nor is the placeholder a consistency term the synthesiser is told to
    // accept results against: only the distinctive term survives.
    const synthesisInput = mockAnthropicChatStructured.mock.calls[0][0] as { userMessage: string };
    expect(synthesisInput.userMessage).toContain('Consistency terms (the acceptance rule): Berlin');
  });

  it('still reports the placeholder as the organisation it read', async () => {
    mockSearch.mockResolvedValueOnce(STEALTH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
      plan: JSON.stringify({ queries: [], terms: [], organisation: 'Stealth Startup' }),
      synthesis: { ...SYNTHESIS_REPLY, current_organisation: '' },
    });

    const out = await invoke({ url: PROFILE_URL });
    expect(out.properties?.current_organisation).toBe('Stealth Startup');
  });

  it('drops a planned query that names neither the person nor their organisation', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
      plan: JSON.stringify({
        queries: ['graphene in vaccines', '"Alex Example" recent talks'],
        terms: ['Northwind Labs'],
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });

    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    expect(queries).not.toContain('graphene in vaccines');
    expect(queries).toContain('"Alex Example" recent talks');
  });

  it('never reads a page whose title and snippet name neither, however promising the query', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({
      items: [
        {
          link: 'https://county.gov/notices/tax-sale',
          title: 'Municipal tax sale notice',
          // Consistent with a headline term, and still about nobody we asked
          // about: the acceptance rule alone lets this through.
          snippet: 'Berlin township tax sale, parcels listed by lot number.',
        },
      ],
    });
    replies({
      plan: JSON.stringify({
        queries: [{ query: '"Alex Example" news', worth_reading: true }],
        terms: ['Berlin'],
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('reads a page that names the person even when the organisation is a placeholder', async () => {
    mockSearch.mockResolvedValueOnce(STEALTH_INDEX_RESULT).mockResolvedValue({
      items: [
        {
          link: 'https://news.example.com/interview',
          title: 'Alex Example on what comes next',
          snippet: 'A conversation with Alex Example, in Berlin.',
        },
      ],
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'page text' });
    replies({
      plan: JSON.stringify({
        queries: [{ query: '"Alex Example" interview', worth_reading: true }],
        terms: ['Berlin'],
        organisation: 'Stealth Startup',
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });
    expect(mockFetchWithTimeout).toHaveBeenCalledWith('https://news.example.com/interview', null);
  });
});

// ── The answer ────────────────────────────────────────────────────────────

describe('the answer', () => {
  /** What a passage looks like in `activity_text`: the address, then the
   *  words that name the person and a term. */
  const NORTHWIND_PASSAGE = [
    'https://news.example.com/northwind-launch',
    'Northwind Labs launches its platform',
    'Alex Example, Head of Platform at Northwind Labs, said…',
  ].join('\n');
  const OWN_ENTRY_PASSAGE = [
    PROFILE_LINK,
    'Alex Example - Head of Platform - Northwind Labs | LinkedIn',
    'Head of Platform at Northwind Labs. Berlin.',
  ].join('\n');

  it('attaches the passages alone when the synthesiser found nothing consistent', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: NOTHING_CONSISTENT });

    // No summary and no confidence: nothing beyond the text was confirmed.
    const out = await invoke({ url: PROFILE_URL });
    expect(out).toEqual({ properties: { activity_text: `${OWN_ENTRY_PASSAGE}\n\n${NORTHWIND_PASSAGE}` } });
  });

  it('attaches nothing when the synthesiser found nothing and no passage names the person with a term', async () => {
    mockSearch.mockResolvedValueOnce(THIN_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({ plan: PLAN_REPLY, synthesis: NOTHING_CONSISTENT });

    expect(await invoke({ url: PROFILE_URL })).toEqual({});
  });

  it('attaches the six properties with numbered sources and the passages', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    replies({ plan: PLAN_REPLY, synthesis: SYNTHESIS_REPLY });

    const out = await invoke({ url: PROFILE_URL }, { name: 'Alex Example' });
    expect(out.properties).toEqual({
      activity_summary: 'Runs platform at Northwind Labs and launched it in June [1].',
      activity_confidence: 'high',
      current_role: 'Head of Platform',
      current_organisation: 'Northwind Labs',
      activity_sources: `1. https://news.example.com/northwind-launch\n2. ${PROFILE_LINK}`,
      activity_text: `${OWN_ENTRY_PASSAGE}\n\n${NORTHWIND_PASSAGE}`,
    });
  });

  it('attaches the passages alone when the synthesiser call fails outright', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue(ACTIVITY_RESULT);
    mockAnthropicChat.mockResolvedValue(PLAN_REPLY);
    // The forced tool call raises rather than handing back a half-answer.
    mockAnthropicChatStructured.mockRejectedValue(new Error('the tool call was truncated'));

    expect(await invoke({ url: PROFILE_URL })).toEqual({
      properties: { activity_text: `${OWN_ENTRY_PASSAGE}\n\n${NORTHWIND_PASSAGE}` },
    });
  });

  it('attaches the profile\'s own entry alone when the query planner returns something unreadable', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({ plan: 'not json at all', synthesis: NOTHING_CONSISTENT });

    // No plan means no activity queries; the headline alone is what the
    // synthesiser sees, and it found nothing consistent. The profile's own
    // entry still names the person and their organisation, so it comes back.
    expect(await invoke({ url: PROFILE_URL })).toEqual({ properties: { activity_text: OWN_ENTRY_PASSAGE } });
  });
});

// ── The site's own name is not an employer ────────────────────────────────

/** What the index returns now: the site appended after a dash rather than a
 *  pipe, so the naive read takes "LinkedIn" for the organisation. */
const DASHED_INDEX_RESULT = {
  items: [
    {
      link: PROFILE_LINK,
      title: 'Alex Example - Co-Founder at NewCo - LinkedIn',
      snippet: 'Co-Founder at NewCo. Berlin.',
    },
  ],
};

describe('the trailing site name', () => {
  it('is stripped whichever punctuation precedes it, so it never becomes the organisation', async () => {
    mockSearch.mockResolvedValueOnce(DASHED_INDEX_RESULT).mockResolvedValue({ items: [] });
    replies({
      plan: JSON.stringify({ queries: ['"Alex Example" news'], terms: ['NewCo'] }),
      synthesis: { ...SYNTHESIS_REPLY, current_organisation: 'NewCo' },
    });

    const out = await invoke({ url: PROFILE_URL });

    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    // The headline is everything after the name, and the site is no part of it.
    expect(queries).toEqual([SITE_QUERY, '"Alex Example" news']);
    expect(queries.some((q) => q.includes('site:crunchbase.com'))).toBe(false);
    expect(out.properties?.current_organisation).toBe('NewCo');
  });

  it('is a placeholder even when the planner hands it back as the organisation', async () => {
    mockSearch.mockResolvedValueOnce(DASHED_INDEX_RESULT).mockResolvedValue({
      items: [
        {
          link: 'https://directory.example.com/profiles',
          title: 'LinkedIn profiles directory',
          snippet: 'A directory of LinkedIn pages.',
        },
      ],
    });
    replies({
      plan: JSON.stringify({
        queries: [{ query: '"Alex Example" news', worth_reading: true }],
        terms: ['LinkedIn'],
        organisation: 'LinkedIn',
      }),
      synthesis: SYNTHESIS_REPLY,
    });

    await invoke({ url: PROFILE_URL });

    const queries: string[] = mockSearch.mock.calls.map((c) => c[0]);
    // No `"LinkedIn" site:crunchbase.com` expansion…
    expect(queries).toEqual([SITE_QUERY, '"Alex Example" news']);
    // …and a page that names only the site is not about this person, so it is
    // never opened.
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });
});

// ── A document is never a page to read ────────────────────────────────────

describe('what the plugin will open', () => {
  /** One planned query, one result set, and a fetch that always succeeds —
   *  so whatever comes back in `items` is what the fetch decision saw. */
  function planOneQueryOver(items: Array<Record<string, string>>) {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({ items });
    mockFetchWithTimeout.mockResolvedValue({ content: 'page text' });
    replies({
      plan: JSON.stringify({
        queries: [{ query: '"Alex Example" q1', worth_reading: true }],
        terms: ['Northwind Labs'],
      }),
      synthesis: SYNTHESIS_REPLY,
    });
  }

  it('skips an address that names a file, and reads the page beside it', async () => {
    planOneQueryOver([
      {
        link: 'https://example.org/reports/annual-2025.pdf',
        title: 'Northwind Labs annual report',
        snippet: 'Alex Example, Head of Platform.',
      },
      {
        link: 'https://a.example.com/one',
        title: 'Northwind Labs one',
        snippet: 'Alex Example, Head of Platform.',
      },
    ]);

    await invoke({ url: PROFILE_URL });

    expect(mockFetchWithTimeout.mock.calls.map((c) => c[0])).toEqual([
      'https://a.example.com/one',
    ]);
    expect(logs.info()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('Skipped a result that is not a page'),
        meta: expect.objectContaining({
          url: 'https://example.org/reports/annual-2025.pdf',
          reason: 'an address that names a file',
        }),
      }),
    );
  });

  it('skips a document source whose address looks like any other page', async () => {
    mockIsSupportedUrl.mockImplementation((url: unknown) => String(url).includes('docsend.com'));
    planOneQueryOver([
      {
        link: 'https://docsend.com/view/abcdef',
        title: 'Northwind Labs deck',
        snippet: 'Alex Example, Head of Platform.',
      },
    ]);

    await invoke({ url: PROFILE_URL });

    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    expect(logs.info()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('Skipped a result that is not a page'),
        meta: expect.objectContaining({
          url: 'https://docsend.com/view/abcdef',
          reason: 'a document source, not a page',
        }),
      }),
    );
  });

  it('skips a document the organisation expansion turns up too', async () => {
    mockSearch.mockResolvedValueOnce(RICH_INDEX_RESULT).mockResolvedValue({
      items: [
        {
          link: 'https://city.example.gov/unclaimed-property.xlsx',
          title: 'Northwind Labs unclaimed property',
          snippet: 'Alex Example listed among holders.',
        },
      ],
    });
    mockFetchWithTimeout.mockResolvedValue({ content: 'page text' });
    replies({ plan: JSON.stringify({ queries: [], terms: ['Northwind Labs'] }), synthesis: SYNTHESIS_REPLY });

    await invoke({ url: PROFILE_URL });

    // The aggregator expansion ran and still opened nothing.
    expect(mockSearch.mock.calls.map((c) => c[0])[1]).toContain('site:crunchbase.com');
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });
});
