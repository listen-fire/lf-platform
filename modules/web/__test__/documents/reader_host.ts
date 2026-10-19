// A reader host for the tests: the browser it is given, and every other
// service answering as a quiet host would (no model, no ops channel), with
// what the reader asked of them kept for the test to read.

import type { BrowserSlot } from 'movement-engine/public/browser';
import { emptyBrowserSlot } from 'movement-engine/public/browser';
import type { DocumentReaderHost, ReaderAlertChannel } from '../../documents/host';

export interface RecordingReaderHost extends DocumentReaderHost {
  alerts: Array<{ channel: ReaderAlertChannel; opsTitle: string }>;
  errors: unknown[];
}

export function readerHost(browser: BrowserSlot = emptyBrowserSlot('the test host has no browser')): RecordingReaderHost {
  const alerts: RecordingReaderHost['alerts'] = [];
  const errors: unknown[] = [];
  return {
    browser,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async () => {
      throw new Error('the test host fetches nothing');
    },
    vision: async () => {
      throw new Error('the test host has no vision model');
    },
    deckName: async () => null,
    alert: async ({ channel, opsTitle }) => void alerts.push({ channel, opsTitle }),
    keepScreenshot: async () => 'https://screenshots.test/kept.png',
    reportError: (err) => void errors.push(err),
    googleDriveApiKey: () => {
      throw new Error('the test host has no Drive key');
    },
    alerts,
    errors,
  };
}
