// `web.render(text)`: text or HTML drawn as a PDF by the host's browser, the
// way a page is printed to PDF. HTML (an email body, a report) keeps its
// layout; plain text is put on a page with its line breaks kept. Which
// characters print is whatever the browser's fonts cover, so CJK, symbols and
// right-to-left text come out as the browser shapes them.
//
// A browser is the host's to lend (its browser slot). With none, the call is
// refused by name, as a gated document is; there is no fallback to another
// writer, which would hand back a PDF that silently differs by host.

import type { PluginAnswer } from 'module-kit';
import type { BrowserSlot } from 'movement-engine/public/browser';

const PAGE_SIZES = ['a4', 'letter'] as const;
type PageSize = (typeof PAGE_SIZES)[number];

const DEFAULT_MARGIN = 30;
const MAX_MARGIN = 200;
const POINTS_PER_INCH = 72;

/** `render` called on a host whose browser slot is empty. */
export class BrowserSlotEmptyForRender extends Error {
  constructor(why: string) {
    super(`@lf/web: render needs a browser, and the host's browser slot is empty (${why})`);
    this.name = 'BrowserSlotEmptyForRender';
  }
}

function pageSizeOf(value: unknown): PageSize {
  if (value === undefined || value === null) return 'a4';
  const size = PAGE_SIZES.find((s) => s === value);
  if (size === undefined) throw new Error(`@lf/web: pageSize is ${PAGE_SIZES.map((s) => `"${s}"`).join(' or ')}, not ${JSON.stringify(value)}`);
  return size;
}

function marginOf(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_MARGIN;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_MARGIN) {
    throw new Error(`@lf/web: margin is a whole number of points from 0 to ${MAX_MARGIN}, not ${JSON.stringify(value)}`);
  }
  return value;
}

// A whole document, or markup a page is made of. A text that merely contains
// a "<" (a comparison, an address in angle brackets) is not HTML.
const HTML_DOCUMENT = /^\s*(<!doctype\s+html|<html[\s>])/i;
const HTML_MARKUP = /<\/?(p|div|br|span|table|tr|td|th|body|head|h[1-6]|ul|ol|li|a|b|i|u|strong|em|img|style|center|font|section|article|blockquote|pre|hr)(\s[^>]*)?\/?>/i;

export function looksLikeHtml(text: string): boolean {
  return HTML_DOCUMENT.test(text) || HTML_MARKUP.test(text);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Scripts never run: a page is drawn, not executed. Images, styles and fonts
// may still be fetched over https, which is what an email's layout needs.
const CONTENT_SECURITY_POLICY =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data:; style-src \'unsafe-inline\' https:; font-src https: data:">';

const CHARSET = '<meta charset="utf-8">';

/** The page the browser draws: HTML as it came, with the script lock and a
 *  charset added; plain text wrapped so its spacing and line breaks survive. */
export function pageOf(text: string): string {
  const head = CHARSET + CONTENT_SECURITY_POLICY;
  if (!looksLikeHtml(text)) {
    return (
      `<!doctype html><html><head>${head}<style>` +
      'body{margin:0}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:8;' +
      'font:11pt/1.4 system-ui,"Segoe UI","Helvetica Neue",Arial,"Noto Sans","Noto Sans CJK SC","Noto Color Emoji",sans-serif}' +
      `</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`
    );
  }
  if (/<head[\s>]/i.test(text)) return text.replace(/<head(\s[^>]*)?>/i, (open) => `${open}${head}`);
  if (/<html[\s>]/i.test(text)) return text.replace(/<html(\s[^>]*)?>/i, (open) => `${open}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${text}</body></html>`;
}

export async function renderPlugin(browser: BrowserSlot, config: Record<string, unknown>): Promise<PluginAnswer> {
  const { text } = config;
  if (typeof text !== 'string') throw new Error('@lf/web: render takes the text or HTML to draw');
  const pageSize = pageSizeOf(config.pageSize);
  const margin = `${(marginOf(config.margin) / POINTS_PER_INCH).toFixed(4)}in`;
  if (browser.emptyBecause !== undefined) throw new BrowserSlotEmptyForRender(browser.emptyBecause);
  const pdf = await browser.withPage(async (page) => {
    await page.setContent(pageOf(text), { waitUntil: 'load' });
    return page.pdf({
      format: pageSize === 'letter' ? 'Letter' : 'A4',
      printBackground: true,
      margin: { top: margin, right: margin, bottom: margin, left: margin },
    });
  });
  return { files: { value: { name: 'movement-artifact.pdf', contentType: 'application/pdf', base64: pdf.toString('base64') } } };
}
