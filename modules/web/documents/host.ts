// What the gated-document reader needs from whoever runs it. The reader is
// web-fetching logic — find the deck behind a share link, get past its email
// form, page through the slides and keep each as an image, or download the
// file when the viewer offers it — so it lives in `@lf/web`. What it leans on
// is the host's: a browser to drive (the browser slot), a vision model for
// the pages no source-specific path knows, and somewhere to raise an alarm
// when a source stops working.
//
// The platform passes its own services, so the reader asks of it exactly what
// it asked before it moved here. Off the platform the browser slot is empty,
// and a gated address is refused before the reader is reached (standalone.ts).
//
// The reader's bodies were written against ambient services, so they read
// the host of the read in progress from an async scope rather than through
// every constructor (the same arrangement as the plugins' tools).

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ModuleLog } from 'module-kit';
import type { BrowserSlot } from 'movement-engine/public/browser';

/** Who an alert is for: the deal-flow channel (a source stopped yielding
 *  anything) or support (a link someone shared needs what they did not give). */
export type ReaderAlertChannel = 'DEALFLOW' | 'SUPPORT';

export interface DocumentReaderHost {
  browser: BrowserSlot;
  log: ModuleLog;
  /** Plain downloads (a direct PDF link, a Drive file). */
  fetch: typeof fetch;
  /** One look at a screenshot by a vision model: its reply's text. */
  vision(input: { system: string; screenshot: Buffer; text: string; label: string }): Promise<string>;
  /** Which of a data room's documents is the pitch deck, by name; null when
   *  none looks like one. */
  deckName(documentNames: string): Promise<string | null | undefined>;
  /** Tell whoever watches the reader. */
  alert(input: { channel: ReaderAlertChannel; text: string; opsTitle: string }): Promise<void>;
  /** Keep a screenshot where an alert can link to it: its URL. */
  keepScreenshot(png: Buffer): Promise<string>;
  /** An error no caller will see, for whoever watches. */
  reportError(err: unknown): void;
  /** The key a shared Google Drive file is read with directly. Throws when
   *  the host has none; the reader then pages through Google's viewer. */
  googleDriveApiKey(): string;
}

const scope = new AsyncLocalStorage<DocumentReaderHost>();

export function withReaderHost<T>(host: DocumentReaderHost, body: () => Promise<T>): Promise<T> {
  return scope.run(host, body);
}

/** The host of the read in progress. */
export function readerHost(): DocumentReaderHost {
  const current = scope.getStore();
  if (current === undefined) throw new Error('@lf/web: the document reader ran outside a read (no host in scope)');
  return current;
}

export const logger: ModuleLog = {
  debug: (message, meta) => readerHost().log.debug(message, meta),
  info: (message, meta) => readerHost().log.info(message, meta),
  warn: (message, meta) => readerHost().log.warn(message, meta),
  error: (message, meta) => readerHost().log.error(message, meta),
};

/** Raise an alarm, never failing the read for it. */
export async function alert(input: { channel: ReaderAlertChannel; text: string; opsTitle: string }): Promise<void> {
  await readerHost().alert(input);
}

export function reportError(err: unknown): void {
  readerHost().reportError(err);
}
