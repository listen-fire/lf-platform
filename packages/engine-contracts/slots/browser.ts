// The browser slot's methods (docs/contracts/browser-slot.md): a page a
// module drives, held open by a session between calls. A session is opened,
// driven one step per call, and closed; the server bounds each session as the
// slot does in process (a few at once, a wall-clock limit). Elements are
// named by a locator chain, read afresh on every step, as a locator is.
// Functions run in the page cross as their source text. Bytes (a screenshot,
// a PDF) come back base64. Routes and downloads do not cross the wire: a
// module needing them is served in the browser's own process.

import { z } from 'zod';

export const BROWSER_METHODS = ['browser.open', 'browser.page', 'browser.close'] as const;

const TextMatch = z.union([z.string(), z.object({ regex: z.string(), flags: z.string().default('') })]);
export type WireTextMatch = z.infer<typeof TextMatch>;

/** One link of a locator chain, from the page down. */
export const LocatorStep = z.union([
  z.object({ selector: z.string() }),
  z.object({ role: z.enum(['button', 'textbox', 'link', 'checkbox', 'heading', 'dialog']), name: TextMatch.optional(), exact: z.boolean().optional() }),
  z.object({ testId: TextMatch }),
  z.object({ label: TextMatch, exact: z.boolean().optional() }),
  z.object({ nth: z.number().int() }),
  z.object({ first: z.literal(true) }),
  z.object({ filter: z.object({ hasText: TextMatch.optional(), hasNotText: TextMatch.optional() }) }),
]);
export type LocatorStepShape = z.infer<typeof LocatorStep>;

export const BrowserOpenRequest = z.object({
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  userAgent: z.string().optional(),
});
/** The session, and how long it may last (the server's limit): a client is refused past it too. */
export const BrowserOpenAnswer = z.object({ session: z.string().min(1), deadlineMs: z.number().int().positive().optional() });

/** What a page step does: a page operation, or (with `locator`) one on the
 *  elements the chain finds. */
export const PAGE_OPS = [
  'goto',
  'url',
  'title',
  'setContent',
  'setViewportSize',
  'keyboard.press',
  'waitForTimeout',
  'waitForLoadState',
  'waitForSelector',
  'waitForFunction',
  'evaluate',
  'screenshot',
  'pdf',
] as const;
export const LOCATOR_OPS = [
  'count',
  'click',
  'fill',
  'press',
  'check',
  'uncheck',
  'scrollIntoViewIfNeeded',
  'waitFor',
  'isVisible',
  'isEnabled',
  'isDisabled',
  'boundingBox',
  'getAttribute',
  'textContent',
  'innerHTML',
  'screenshot',
  'evaluate',
  'evaluateAll',
] as const;

export const BrowserPageRequest = z.object({
  session: z.string(),
  op: z.string(),
  /** The operation's arguments in order; a function as `{ source }`. */
  args: z.array(z.unknown()).default([]),
  locator: z.array(LocatorStep).optional(),
});
export type BrowserPageRequestShape = z.infer<typeof BrowserPageRequest>;

/** A step's answer: its value, or `{ bytes }` (base64) for a screenshot or PDF, and the page's URL after it. */
export const BrowserPageAnswer = z.object({ value: z.unknown().optional(), bytes: z.string().optional(), url: z.string().optional() });

export const BrowserCloseRequest = z.object({ session: z.string() });

/** A function the page runs, by its source text. */
export const WireFunction = z.object({ source: z.string() });
