// The tools a host other than the platform runs the web plugins with, built
// from what any host hands a module: its fetch, its credential and its log.
//
//   - Models: Anthropic, on the credential's `anthropicApiKey` (and
//     `anthropicBaseUrl` for another endpoint speaking the same API). Each
//     call is priced from the shared price table and reported on the answer,
//     since no meter of the host's sees it.
//   - Search: Bright Data's SERP zone (`brightDataAccessToken`,
//     `brightDataSerpZone`), one attempt per query.
//   - Pages: Bright Data's Web Unlocker (`brightDataAccessToken`,
//     `brightDataUnlockerZone`) when configured, else a plain GET — a local
//     host reads the open web as its user does.
//   - No profile reader: a profile address fails, naming what is not
//     available off the platform.
//   - Gated documents (a deck host, a data room, a Notion page) are read
//     through the host's browser slot (`ctx.browser`), the downloaded file
//     kept in the host's files (`ctx.files`). Where the slot is empty — lf
//     and serve-module today — a document source fails naming the slot.
//     A page whose body is not HTML or text is not kept.
//   - A plain PDF, PowerPoint or spreadsheet link is fetched and read through
//     the file-text package: a PDF's text layer, else the host's ocr slot
//     (`ctx.ocr`, a deck of screenshots compiled into a PDF). Where the slot
//     is empty a scanned PDF reads as nothing, the log saying why.
//
// `ctx.config.baseUrlOverride` stands in for api.brightdata.com and Anthropic
// alike, so a test serves both from one fake.

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import type { ModuleContext } from 'module-kit';

import { Readable } from 'node:stream';

import { z } from 'zod';
import { fileDescriptorOf, type FileRef } from 'engine-contracts';
import { makeFileTextResolver, type FileTextReader } from 'file-text';
import type { ChatCall } from '@listen-fire/anthropic';
import type { ChatModelName } from 'movement-engine/public/models';
import type { FetchedResource, SearchResult, WebTools } from './tools';

import { anthropicClient, anthropicKeyedChatProvider, type LlmUsage } from '@listen-fire/anthropic';
import { costMicrodollars } from '@listen-fire/anthropic';
import { models } from 'movement-engine/public/models';
import { FULLY_SUPPORTED_DOCUMENT_REGEXES, NOTION_REGEX, PDF_REGEX, PPTX_REGEX, XLSX_REGEX } from 'engine-contracts/document_sources';
import { isLinkedInUrl, looksLikeNonHtmlAddress } from './addresses';
import { documentReader, type DocumentReader } from './documents/reader';

/** The files read as text off the platform: the address or the response's
 *  type says it is a PDF, a PowerPoint deck or a spreadsheet. */
const READABLE_FILE_ADDRESS = /\.(?:pdf|pptx|xlsx)$/i;
const READABLE_FILE_TYPE = /pdf|presentationml|spreadsheetml/i;

function isReadableFileAddress(url: string): boolean {
  try {
    return READABLE_FILE_ADDRESS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

interface DownloadedFile {
  name: string;
  contentType: string;
  bytes: Buffer;
}

const BRIGHT_DATA = 'https://api.brightdata.com';
const PAGE_CHAR_LIMIT = 50_000;
const PAGE_TIMEOUT_MS = 60_000;

/** The credential's fields the standalone tools read. Every one is optional:
 *  a plugin that needs none of them (fetching an open page) runs without. */
export const WEB_CREDENTIAL_FIELDS: WireCredentialDeclarationShape['fields'] = [
  { name: 'anthropicApiKey', label: 'Anthropic API key', optional: true },
  { name: 'anthropicBaseUrl', label: 'Anthropic base URL', secret: false, optional: true },
  { name: 'brightDataAccessToken', label: 'Bright Data access token', optional: true },
  { name: 'brightDataSerpZone', label: 'Bright Data SERP zone', secret: false, optional: true },
  { name: 'brightDataUnlockerZone', label: 'Bright Data Web Unlocker zone', secret: false, optional: true },
  { name: 'googleDriveApiKey', label: 'Google Drive API key (a shared Drive file read directly)', optional: true },
];

type Fields = Readonly<Record<string, string>>;

/** The addresses the platform reads through its document sources (a browser
 *  for gated decks and data rooms, a store that keeps the file). Canva's edit
 *  links are read as its view links there, so any design link is one. A plain
 *  PDF, PowerPoint or spreadsheet link is not one: it is fetched and read here. */
const PLAIN_FILE_LINKS = [PDF_REGEX, PPTX_REGEX, XLSX_REGEX];
const DOCUMENT_SOURCES = [
  ...FULLY_SUPPORTED_DOCUMENT_REGEXES.filter((source) => !PLAIN_FILE_LINKS.includes(source)),
  NOTION_REGEX,
  /^https:\/\/www\.canva\.com\/design\//,
];

export function isDocumentSourceAddress(url: string): boolean {
  return DOCUMENT_SOURCES.some((source) => source.test(url));
}

/** What this host cannot do that the platform does, as the refusal a plugin
 *  call fails with. */
export class NotAvailableOffPlatform extends Error {
  constructor(what: string, needs: string) {
    super(`@lf/web: ${what} needs ${needs}, which is not available off the platform`);
    this.name = 'NotAvailableOffPlatform';
  }
}

const PROFILE_READER = "the platform's LinkedIn profile reader";

/** A document source read with no browser in the host's slot. */
export class BrowserSlotEmptyForDocument extends Error {
  constructor(url: string, why: string) {
    super(`@lf/web: reading the document at ${url} needs a browser, and the host's browser slot is empty (${why})`);
    this.name = 'BrowserSlotEmptyForDocument';
  }
}

const DOCUMENT_TYPES: ReadonlyArray<[RegExp, string]> = [
  [/\.pdf$/i, 'application/pdf'],
  [/\.pptx$/i, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  [/\.xlsx$/i, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
];

function documentType(name: string): string {
  return DOCUMENT_TYPES.find(([pattern]) => pattern.test(name))?.[1] ?? 'application/pdf';
}

/** The fields, or none when the host connected no credential. */
async function fieldsOf(ctx: ModuleContext): Promise<Fields> {
  try {
    return await ctx.credential.fields();
  } catch {
    return {};
  }
}

export async function standaloneTools(ctx: ModuleContext): Promise<WebTools> {
  const fields = await fieldsOf(ctx);
  const brightData = ctx.config.baseUrlOverride ?? BRIGHT_DATA;
  let spent = 0;

  const models_ = anthropicClient({
    chatCallFor: (name) => anthropicCall(name, fields, ctx.config.baseUrlOverride),
    recordUsage: async (usage) => {
      spent += priced(usage) ?? 0;
    },
    logFields: () => ({}),
  });

  async function brightDataRequest(zone: string, url: string): Promise<Response> {
    return ctx.fetch(`${brightData}/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fields.brightDataAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, url, format: 'raw' }),
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  }

  async function get(url: string): Promise<Response> {
    const zone = fields.brightDataUnlockerZone;
    const response =
      fields.brightDataAccessToken && zone
        ? await brightDataRequest(zone, url)
        : await ctx.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
    return response;
  }

  async function scrape(url: string): Promise<string> {
    if (looksLikeNonHtmlAddress(url)) return '';
    const response = await get(url);
    const type = response.headers.get('content-type') ?? '';
    if (type && !/html|text|xml|json/i.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      return '';
    }
    return pageText(await response.text());
  }

  const readFile: FileTextReader<DownloadedFile> = makeFileTextResolver<DownloadedFile>({
    openBytes: async (file) => ({ stream: Readable.from(file.bytes), size: file.bytes.length }),
    // A PDF with no text layer of its own (screenshots compiled into a deck)
    // is read by the host's ocr slot, its cost charged to this call.
    ocrPdf: async (stream) => {
      if (ctx.ocr.emptyBecause !== undefined) return { unreadable: 'extraction_failed', detail: `a scanned PDF needs OCR: ${ctx.ocr.emptyBecause}` };
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return (await ctx.ocr.read({ bytes: Buffer.concat(chunks), contentType: 'application/pdf', label: '@lf/web' })).text;
    },
    transcribe: async () => {
      throw new Error('@lf/web: audio is not read off the platform');
    },
    analyzeSheet: ({ temperature, system, userMessage }) =>
      models_.anthropicChat({ model: 'claude-sonnet-5', temperature, system, userMessage, label: 'excel-semantic-analysis' }),
    rawText: { getOrCreateId: async () => undefined },
    logger: ctx.log,
  });

  /** A file link's text, or null when none could be read (said on the log). */
  async function fileText(url: string, response: Response): Promise<string | null> {
    const file: DownloadedFile = {
      name: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
      contentType: response.headers.get('content-type') ?? '',
      bytes: Buffer.from(await response.arrayBuffer()),
    };
    const read = await readFile({ file });
    if ('unreadable' in read) {
      ctx.log.warn('@lf/web: a linked file could not be read', { url, reason: read.unreadable, detail: read.detail });
      return null;
    }
    return read.text;
  }

  // The gated-document reader over this host: its browser slot, its fetch,
  // and Anthropic (on the credential) for the vision fallback and for
  // picking a data room's deck. Built on the first gated address.
  let reader: DocumentReader | undefined;
  function documents(): DocumentReader {
    reader ??= documentReader({
      browser: ctx.browser,
      log: ctx.log,
      fetch: ctx.fetch,
      async vision({ system, screenshot, text, label }) {
        const call = anthropicCall('claude-sonnet-5', fields, ctx.config.baseUrlOverride);
        const response = await call.client.messages.create({
          model: call.wireModel,
          max_tokens: 4096,
          system,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot.toString('base64') } },
                { type: 'text', text },
              ],
            },
          ],
        });
        spent +=
          priced({
            resolved: call.resolved,
            callType: 'chat',
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            label,
          }) ?? 0;
        return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      },
      async deckName(documentNames) {
        const { name } = await models_.anthropicChatStructured({
          model: 'claude-sonnet-5',
          system: DECK_NAME_SYSTEM,
          userMessage: documentNames,
          schema: DeckName,
          toolName: 'pick_pitch_deck',
          toolDescription: 'Name the document most likely to be the pitch deck.',
          label: 'GET_PITCH_DECK_NAME',
        });
        return name;
      },
      // No ops channel off the platform: an alert is a log line.
      alert: async ({ channel, text, opsTitle }) => ctx.log.warn(opsTitle, { channel, text }),
      keepScreenshot: async () => '(screenshots are not kept off the platform)',
      reportError: (err) => ctx.log.error('@lf/web: the document reader failed', { error: describe(err) }),
      googleDriveApiKey: () => {
        if (!fields.googleDriveApiKey) throw new Error('@lf/web: no googleDriveApiKey on its credential');
        return fields.googleDriveApiKey;
      },
    });
    return reader;
  }

  /** A gated document read through the browser slot, kept in the host's files. */
  async function gatedDocument(url: string, email: string | null, password: string | null | undefined): Promise<FetchedResource | null> {
    const empty = ctx.browser.emptyBecause;
    if (empty !== undefined) throw new BrowserSlotEmptyForDocument(url, empty);
    const credentials = { ...(email ? { email } : {}), ...(password ? { password } : {}) };
    const read = documents();
    if (read.outputFormat(url) === 'TEXT') {
      const text = await read.getUrlAsText(url, credentials);
      return text ? { url, content: text.slice(0, PAGE_CHAR_LIMIT), file: null } : null;
    }
    const pdf = await read.getUrlAsPdfStream(url, credentials);
    if (pdf === null) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of pdf.data) chunks.push(Buffer.from(chunk));
    const file: DownloadedFile = { name: pdf.name, contentType: documentType(pdf.name), bytes: Buffer.concat(chunks) };
    const ref = await ctx.files.put({ bytes: file.bytes, name: file.name, contentType: file.contentType });
    const text = await readFile({ file });
    if ('unreadable' in text) ctx.log.warn('@lf/web: a gated document has no readable text', { url, reason: text.unreadable, detail: text.detail });
    const content = 'unreadable' in text ? '' : text.text.slice(0, PAGE_CHAR_LIMIT);
    return { url, content, file: ref };
  }

  async function search(query: string): Promise<{ items: SearchResult[] }> {
    const zone = fields.brightDataSerpZone;
    if (!fields.brightDataAccessToken || !zone) {
      throw new Error('@lf/web: web search needs brightDataAccessToken and brightDataSerpZone on its credential');
    }
    const target = new URL('https://www.google.com/search');
    target.searchParams.set('q', query);
    target.searchParams.set('brd_json', '1');
    const response = await brightDataRequest(zone, target.toString());
    if (!response.ok) throw new Error(`Bright Data search failed: ${response.status} ${response.statusText}`);
    return { items: organicResults(await response.json()) };
  }

  return {
    log: ctx.log,
    logFields: () => ({}),
    models: {
      anthropicChat: models_.anthropicChat,
      anthropicChatStructured: models_.anthropicChatStructured,
      anthropicWebChat: models_.anthropicWebChat,
    },
    searchProvider: () => 'brightdata',
    search,
    async findLinkedIn({ name, company }) {
      const found = await search(`site:linkedin.com/in ${name}${company ? ` ${company}` : ''}`);
      return (found.items ?? []).filter((hit) => typeof hit.link === 'string' && /linkedin\.com\/in\//i.test(hit.link));
    },
    scrape,
    missingScraperSettings: () => [],
    profiles: {
      getProfileTextByUrl: async (url) => {
        throw new NotAvailableOffPlatform(`reading the LinkedIn profile ${url}`, PROFILE_READER);
      },
    },
    isDocumentSource: isDocumentSourceAddress,
    async fetchResource(url, email, password): Promise<FetchedResource | null> {
      if (isLinkedInUrl(url)) throw new NotAvailableOffPlatform(`reading the LinkedIn profile ${url}`, PROFILE_READER);
      if (isDocumentSourceAddress(url)) return gatedDocument(url, email, password);
      let content: string;
      if (isReadableFileAddress(url) || !looksLikeNonHtmlAddress(url)) {
        const response = await get(url);
        const type = response.headers.get('content-type') ?? '';
        if (isReadableFileAddress(url) || READABLE_FILE_TYPE.test(type)) {
          content = (await fileText(url, response)) ?? '';
        } else if (type && !/html|text|xml|json/i.test(type)) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        } else {
          content = pageText(await response.text());
        }
      } else {
        return null;
      }
      if (!content || content.trim().length < 50) return null;
      if (content.length > PAGE_CHAR_LIMIT) content = content.slice(0, PAGE_CHAR_LIMIT);
      return { url, content, file: null };
    },
    // The only handles handed out are the files a gated document was kept as.
    fileValues: async (handles) => handles.map((handle): FileRef | undefined => fileDescriptorOf(handle)),
    spentMicrodollars: () => spent,
  };
}

function anthropicCall(name: ChatModelName, fields: Fields, baseUrlOverride: string | undefined): ChatCall {
  const apiKey = fields.anthropicApiKey;
  if (!apiKey) throw new Error('@lf/web: a model call needs anthropicApiKey on its credential');
  const { home } = models[name];
  if (home !== 'anthropic') throw new Error(`@lf/web: model "${name}" is served by ${home}; this host calls only Anthropic`);
  const baseUrl = baseUrlOverride ?? fields.anthropicBaseUrl;
  return {
    client: anthropicKeyedChatProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
    wireModel: name,
    resolved: { preferred: name, provider: 'anthropic', wireModel: name },
  };
}

function priced(usage: LlmUsage): number | undefined {
  return costMicrodollars(`${usage.resolved.provider}/${usage.resolved.wireModel}`, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
  });
}

const DeckName = z.object({ name: z.string().nullable().optional() });

// The platform's prompt for the same question (lib/prompts get_pitch_deck_name).
const DECK_NAME_SYSTEM = `You are my virtual assistant in a VC firm.
I will send you a list of newline-separated names of documents in a dataroom.
You must respond with the name of the document you think is most likely a pitch deck.
If there are multiple candidates, you must pick only the most likely one; if none looks like a pitch deck, give no name.`;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Only the fields read here are declared; the rest of Google's parsed result
// set passes through unread.
const SerpReply = z.object({
  organic: z.array(z.object({ link: z.string().optional(), title: z.string().optional(), description: z.string().optional() })),
});

function organicResults(body: unknown): SearchResult[] {
  const parsed = SerpReply.safeParse(body);
  if (!parsed.success) throw new Error('Bright Data search answered without an organic result list');
  return parsed.data.organic.map((hit) => ({ link: hit.link ?? null, title: hit.title ?? null, snippet: hit.description ?? null }));
}

/** A page's readable text: scripts, styles and tags dropped, entities read,
 *  whitespace folded. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
