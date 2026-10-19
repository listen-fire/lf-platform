// `pdf.render(text)`: the plugin's body. Draws the text with the thin
// Helvetica writer and answers the PDF as a file for the host to store, with a
// warning when some characters could not be drawn.

import type { PluginAnswer } from 'module-kit';

import { DEFAULT_LAYOUT, MAX_MARGIN, PAGE_SIZES, renderPlainTextPdf, type PageSize, type PdfLayout } from './plain_text_pdf';

/** How many undrawable characters a warning lists before it says "and more". */
const LISTED = 10;

function pageSizeOf(value: unknown): PageSize {
  if (value === undefined || value === null) return DEFAULT_LAYOUT.pageSize;
  const size = PAGE_SIZES.find((s) => s === value);
  if (size === undefined) throw new Error(`@lf/pdf: pageSize is ${PAGE_SIZES.map((s) => `"${s}"`).join(' or ')}, not ${JSON.stringify(value)}`);
  return size;
}

function marginOf(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LAYOUT.margin;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_MARGIN) {
    throw new Error(`@lf/pdf: margin is a whole number of points from 0 to ${MAX_MARGIN}, not ${JSON.stringify(value)}`);
  }
  return value;
}

function layoutOf(config: Record<string, unknown>): PdfLayout {
  return { pageSize: pageSizeOf(config.pageSize), margin: marginOf(config.margin) };
}

/** The warning for characters the writer printed as "?". */
export function lackingWarning(lacking: readonly string[]): string {
  const shown = lacking.slice(0, LISTED).join(' ');
  const more = lacking.length > LISTED ? ` and ${lacking.length - LISTED} more` : '';
  return (
    `@lf/pdf's default writer draws Latin-1 text in Helvetica, so ${lacking.length === 1 ? 'this character was' : 'these characters were'} printed as "?": ${shown}${more}. ` +
    'A Unicode PDF module (one that embeds a font) can replace this one; on a host with a browser, web.render (from @lf/web) prints any text the browser\'s fonts cover.'
  );
}

export function renderPlugin(config: Record<string, unknown>): PluginAnswer {
  const { text } = config;
  if (typeof text !== 'string') throw new Error('@lf/pdf: render takes the text to draw');
  const { bytes, lacking } = renderPlainTextPdf(text, layoutOf(config));
  return {
    files: { value: { name: 'movement-artifact.pdf', contentType: 'application/pdf', base64: bytes.toString('base64') } },
    ...(lacking.length > 0 ? { warnings: [lackingWarning(lacking)] } : {}),
  };
}
