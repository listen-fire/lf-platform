// The gated-document reader: a share link to a deck or a data room (DocSend,
// Pitch, Canva, Google Slides, Papermark, …) read into the document behind
// it, or a Notion page into its text. Each source drives a browser through
// the host's browser slot (host.ts); a plain file link is downloaded.

import type { Readable } from 'node:stream';

import { withReaderHost, type DocumentReaderHost } from './host';
import { toUrl } from './waits';
import { DocsendService } from './docsend';
import { FigmaService } from './figma';
import { genericLink } from './generic_link';
import { GoogleDocsService } from './google_docs';
import { PitchDotComService } from './pitch_dot_com';
import { BrieflinkService } from './brieflink';
import { TomeService } from './tome';
import { CanvaService, normalizeCanvaUrl } from './canva';
import { PapermarkService } from './papermark';
import { NotionService } from './notion';

import {
  BRIEFLINK_REGEX,
  CANVA_REGEX,
  DOCSEND_REGEX,
  FIGMA_REGEX,
  FULLY_SUPPORTED_DOCUMENT_REGEXES,
  GOOGLE_DOCS_REGEX,
  GOOGLE_DRIVE_REGEX,
  PDF_REGEX,
  PITCH_DOT_COM_REGEX,
  PPTX_REGEX,
  XLSX_REGEX,
  TOME_REGEX,
  NOTION_REGEX,
  PAPERMARK_REGEX,
} from 'engine-contracts/document_sources';

const TEXT_REGEXES = [NOTION_REGEX];

export interface DocumentReaderOptions {
  /** Read Figma links too. Off by default: rendering Figma needs a GPU,
   *  which the platform's production browser does not have. */
  figma?: boolean;
}

interface PdfStream {
  type: 'PDF_STREAM';
  data: Readable;
  name: string;
}

interface ExternalUrl {
  type: 'EXTERNAL_URL';
  url: string;
}

class DocumentReader {
  private readonly DOCUMENT_REGEXES: RegExp[];
  private readonly PITCH_DECK_REGEX: RegExp;

  constructor(
    private readonly host: DocumentReaderHost,
    options: DocumentReaderOptions,
  ) {
    this.DOCUMENT_REGEXES = FULLY_SUPPORTED_DOCUMENT_REGEXES.concat(options.figma ? [FIGMA_REGEX] : []);
    const pitchDeckRegexes = this.DOCUMENT_REGEXES.concat(TEXT_REGEXES);
    this.PITCH_DECK_REGEX = new RegExp(pitchDeckRegexes.map((r) => `(${r.source})`).join('|'));
  }

  isSupportedUrl(url: string) {
    return !!normalizeCanvaUrl(url).match(this.PITCH_DECK_REGEX);
  }

  /*
   * Everything downstream of here — the format decision, the regex that picks
   * a fetcher, and the URL the fetcher is handed — reads the sanitized URL, so
   * a source whose canonical route differs from the one people paste is
   * rewritten once, here.
   */
  sanitizeUrl(url: string) {
    return normalizeCanvaUrl(toUrl(url).toString());
  }

  outputFormat(input: string): 'DOCUMENT' | 'TEXT' {
    const url = this.sanitizeUrl(input);

    if (this.DOCUMENT_REGEXES.some((regex) => regex.test(url))) {
      return 'DOCUMENT';
    } else if (TEXT_REGEXES.some((regex) => regex.test(url))) {
      return 'TEXT';
    } else {
      throw new Error(`Unsupported document source: ${url}`);
    }
  }

  /** The document behind a share link, or null when it could not be read. */
  getUrlAsPdfStream(input: string, credentials: { email?: string; password?: string }): Promise<PdfStream | null> {
    return withReaderHost(this.host, () => this.readDocument(input, credentials));
  }

  /** A Notion page's text, or null when it could not be read. */
  getUrlAsText(input: string, credentials: { email?: string; password?: string }): Promise<string | null> {
    return withReaderHost(this.host, () => this.readText(input, credentials));
  }

  private async readDocument(
    input: string,
    { email, password }: { email?: string; password?: string },
  ): Promise<PdfStream | null> {
    const url = this.sanitizeUrl(input);

    if (DOCSEND_REGEX.test(url)) {
      const result = await DocsendService.getAsPdf(url, { email, password });
      if (result?.type === 'EXTERNAL_URL') {
        return this.readDocument(result.url, { email, password });
      }

      return result;
    }

    if (GOOGLE_DOCS_REGEX.test(url) || GOOGLE_DRIVE_REGEX.test(url)) {
      return GoogleDocsService.getAsPdf(url);
    }

    if (PITCH_DOT_COM_REGEX.test(url)) {
      return PitchDotComService.getAsPdf(url, { email, passcode: password });
    }

    if (BRIEFLINK_REGEX.test(url)) {
      return BrieflinkService.getAsPdf(url, { email, passcode: password });
    }

    if (TOME_REGEX.test(url)) {
      return TomeService.getAsPdf(url, { email, passcode: password });
    }

    if (CANVA_REGEX.test(url)) {
      return CanvaService.getAsPdf(url, { email, passcode: password });
    }

    if (FIGMA_REGEX.test(url)) {
      return FigmaService.getAsPdf(url);
    }

    if (PAPERMARK_REGEX.test(url)) {
      const result = await PapermarkService.getAsPdf(url, { email, passcode: password });

      if (result?.type === 'EXTERNAL_URL') {
        return this.readDocument(result.url, { email, password });
      }

      return result;
    }

    if (PDF_REGEX.test(url)) {
      return genericLink.get(url, 'PDF');
    }

    if (PPTX_REGEX.test(url)) {
      return genericLink.get(url, 'PPTX');
    }

    if (XLSX_REGEX.test(url)) {
      return genericLink.get(url, 'XLSX');
    }

    throw new Error(`Unsupported document source: ${url}`);
  }

  private async readText(
    input: string,
    { email, password }: { email?: string; password?: string },
  ): Promise<string | null> {
    const url = this.sanitizeUrl(input);

    if (NOTION_REGEX.test(url)) {
      return NotionService.getAsText(url, { email, passcode: password });
    }

    throw new Error(`Unsupported document source: ${url}`);
  }
}

/** The reader, over `host`. */
export function documentReader(host: DocumentReaderHost, options: DocumentReaderOptions = {}): DocumentReader {
  return new DocumentReader(host, options);
}

export type { DocumentReader, PdfStream, ExternalUrl };
