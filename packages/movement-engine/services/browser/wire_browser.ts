// The browser slot over the wire (docs/contracts/browser-slot.md, the shapes
// in engine-contracts `slots/browser`): a browser module serves its slot's
// sessions as adapter protocol 2 calls (`browserSlotAnswer`), and a host that
// has no browser of its own fills its slot with a client of one
// (`remoteBrowserSlot`). A session is held open on the server between calls;
// each page step is one call, its elements found afresh by their locator
// chain. The server's limits still bound every session: the client learns the
// session's deadline when it opens and is refused past it, as in process.

import { randomUUID } from 'node:crypto';

import {
  BrowserOpenAnswer,
  BrowserOpenRequest,
  BrowserPageAnswer,
  BrowserPageRequest,
  BrowserCloseRequest,
  type LocatorStepShape,
  type WireTextMatch,
} from 'engine-contracts/slots';

import { SlotClient, SlotRefusal, type SlotAddress, type SlotAnswer } from '../module_wire/wire';
import {
  BROWSER_LIMITS,
  BrowserSessionTimedOut,
  type BrowserLocator,
  type BrowserPage,
  type BrowserPageOptions,
  type BrowserRole,
  type BrowserSession,
  type BrowserSlot,
} from './browser';

// ── The server: a slot's sessions as calls ─────────────────────────────────

interface Held {
  page: BrowserPage;
  session: BrowserSession;
  end: () => void;
}

function matchOf(match: WireTextMatch | undefined): string | RegExp | undefined {
  if (match === undefined || typeof match === 'string') return match;
  return new RegExp(match.regex, match.flags);
}

function locate(page: BrowserPage, chain: readonly LocatorStepShape[]): BrowserLocator {
  let at: BrowserLocator | undefined;
  for (const step of chain) {
    const root = (what: string): never => {
      throw new SlotRefusal('bad_request', `browser.page: a ${what} step only begins a locator chain`);
    };
    if ('selector' in step) at = at === undefined ? page.locator(step.selector) : at.locator(step.selector);
    else if ('role' in step) at = at === undefined ? page.getByRole(step.role as BrowserRole, { name: matchOf(step.name), exact: step.exact }) : root('role');
    else if ('testId' in step) at = at === undefined ? page.getByTestId(matchOf(step.testId) ?? '') : root('testId');
    else if ('label' in step) at = at === undefined ? page.getByLabel(matchOf(step.label) ?? '', { exact: step.exact }) : root('label');
    else if (at === undefined) throw new SlotRefusal('bad_request', 'browser.page: a locator chain begins with a selector, role, testId or label');
    else if ('nth' in step) at = at.nth(step.nth);
    else if ('first' in step) at = at.first();
    else at = at.filter({ hasText: matchOf(step.filter.hasText), hasNotText: matchOf(step.filter.hasNotText) });
  }
  if (at === undefined) throw new SlotRefusal('bad_request', 'browser.page: an empty locator chain');
  return at;
}

/** A function the page runs, rebuilt from its source text. */
function functionOf(value: unknown): (...args: unknown[]) => unknown {
  const source = value !== null && typeof value === 'object' ? Reflect.get(value, 'source') : undefined;
  if (typeof source !== 'string') throw new SlotRefusal('bad_request', 'browser.page: a function crosses as { source }');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the page runs the caller's function, as in process
  return new Function(`return (${source});`)() as (...args: unknown[]) => unknown;
}

const bytes = (buffer: Buffer) => ({ bytes: buffer.toString('base64') });

async function pageStep(page: BrowserPage, op: string, args: unknown[]): Promise<unknown> {
  const [a, b, c] = args as [never, never, never];
  switch (op) {
    case 'goto':
      await page.goto(a, b);
      return {};
    case 'url':
      return { value: page.url() };
    case 'title':
      return { value: await page.title() };
    case 'setContent':
      await page.setContent(a, b);
      return {};
    case 'setViewportSize':
      await page.setViewportSize(a);
      return {};
    case 'keyboard.press':
      await page.keyboard.press(a, b);
      return {};
    case 'waitForTimeout':
      await page.waitForTimeout(a);
      return {};
    case 'waitForLoadState':
      await page.waitForLoadState(a, b);
      return {};
    case 'waitForSelector':
      await page.waitForSelector(a, b);
      return {};
    case 'waitForFunction':
      await page.waitForFunction(functionOf(a) as never, b, c);
      return {};
    case 'evaluate':
      return { value: await page.evaluate(functionOf(a) as never, b) };
    case 'screenshot':
      return bytes(await page.screenshot(a));
    case 'pdf':
      return bytes(await page.pdf(a));
    default:
      throw new SlotRefusal('bad_request', `browser.page: no page step "${op}" crosses the wire`);
  }
}

async function locatorStep(at: BrowserLocator, op: string, args: unknown[]): Promise<unknown> {
  const [a, b] = args as [never, never];
  switch (op) {
    case 'count':
      return { value: await at.count() };
    case 'click':
    case 'check':
    case 'uncheck':
    case 'scrollIntoViewIfNeeded':
    case 'waitFor':
      await at[op](a);
      return {};
    case 'fill':
    case 'press':
      await at[op](a, b);
      return {};
    case 'isVisible':
    case 'isEnabled':
    case 'isDisabled':
    case 'boundingBox':
    case 'textContent':
    case 'innerHTML':
      return { value: await at[op](a) };
    case 'getAttribute':
      return { value: await at.getAttribute(a, b) };
    case 'screenshot':
      return bytes(await at.screenshot(a));
    case 'evaluate':
      return { value: await at.evaluate(functionOf(a) as never, b) };
    case 'evaluateAll':
      return { value: await at.evaluateAll(functionOf(a) as never) };
    default:
      throw new SlotRefusal('bad_request', `browser.page: no element step "${op}" crosses the wire`);
  }
}

/** Serve `slot`'s sessions as the browser slot's methods. `sessionMs` is the
 *  slot's own limit, told to each client so it is refused past it too. */
export function browserSlotAnswer(slot: BrowserSlot, options: { sessionMs?: number } = {}): SlotAnswer {
  const held = new Map<string, Held>();
  const sessionMs = options.sessionMs ?? BROWSER_LIMITS.sessionMs;
  return async (method, params) => {
    if (method === 'browser.open') {
      const asked = BrowserOpenRequest.parse(params);
      const id = randomUUID();
      return new Promise((answer, refuse) => {
        const finished = slot.withPage(
          (page, session) =>
            new Promise<void>((end) => {
              held.set(id, { page, session, end });
              answer({ session: id, deadlineMs: sessionMs });
            }),
          asked as BrowserPageOptions,
        );
        finished.then(
          () => held.delete(id),
          (error: unknown) => {
            held.delete(id);
            refuse(error);
          },
        );
      });
    }
    if (method === 'browser.page') {
      const step = BrowserPageRequest.parse(params);
      const session = held.get(step.session);
      if (session === undefined) throw new SlotRefusal('session_closed', `browser.page: no open session ${step.session} (it was closed, or outlived its limit)`);
      const answer = step.locator === undefined ? await pageStep(session.page, step.op, step.args) : await locatorStep(locate(session.page, step.locator), step.op, step.args);
      return { ...(answer as object), url: session.page.url() };
    }
    if (method === 'browser.close') {
      const { session } = BrowserCloseRequest.parse(params);
      const open = held.get(session);
      held.delete(session);
      if (open !== undefined) {
        await open.session.close();
        open.end();
      }
      return null;
    }
    throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
  };
}

// ── The client: a slot filled by a module elsewhere ─────────────────────────

/** A step's arguments as JSON carries them: trailing absent ones dropped,
 *  so the server's call has the same arity as the caller's. */
function trimmed(args: unknown[]): unknown[] {
  const out = [...args];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

function wireMatch(match: string | RegExp | undefined): WireTextMatch | undefined {
  if (match === undefined || typeof match === 'string') return match;
  return { regex: match.source, flags: match.flags };
}

function wireFunction(fn: unknown): { source: string } {
  return { source: String(fn) };
}

/** The browser slot filled by the browser module at `address`. */
export function remoteBrowserSlot(address: SlotAddress, module = 'a remote browser'): BrowserSlot {
  const client = new SlotClient(address);
  return {
    module,
    withPage: async <T>(fn: (page: BrowserPage, session: BrowserSession) => Promise<T>, options?: BrowserPageOptions): Promise<T> => {
      const opened = await client.read('browser.open', options ?? {}, BrowserOpenAnswer);
      const session = opened.session;
      const deadlineMs = opened.deadlineMs ?? BROWSER_LIMITS.sessionMs;
      let url = 'about:blank';
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await client.call('browser.close', { session }).catch(() => undefined);
      };
      const step = async (op: string, args: unknown[], locator?: LocatorStepShape[]) => {
        const answer = await client.read('browser.page', { session, op, args: trimmed(args), ...(locator !== undefined ? { locator } : {}) }, BrowserPageAnswer);
        if (answer.url !== undefined) url = answer.url;
        return answer;
      };
      const value = async (op: string, args: unknown[], locator?: LocatorStepShape[]) => (await step(op, args, locator)).value;
      const buffer = async (op: string, args: unknown[], locator?: LocatorStepShape[]) => Buffer.from((await step(op, args, locator)).bytes ?? '', 'base64');
      const page = remotePage({ value, buffer, url: () => url });
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserSessionTimedOut(module, deadlineMs)), deadlineMs);
      });
      try {
        return await Promise.race([fn(page, { close }), timedOut]);
      } finally {
        if (timer) clearTimeout(timer);
        await close();
      }
    },
  };
}

interface Steps {
  value(op: string, args: unknown[], locator?: LocatorStepShape[]): Promise<unknown>;
  buffer(op: string, args: unknown[], locator?: LocatorStepShape[]): Promise<Buffer>;
  url(): string;
}

function notOverTheWire(what: string): never {
  throw new Error(`the browser slot's ${what} does not cross the wire: serve the module that needs it in the browser's own process`);
}

function remoteLocator(steps: Steps, chain: LocatorStepShape[]): BrowserLocator {
  const at = (more: LocatorStepShape) => remoteLocator(steps, [...chain, more]);
  const done = async (op: string, args: unknown[]) => {
    await steps.value(op, args, chain);
  };
  const read = <R>(op: string, args: unknown[]) => steps.value(op, args, chain) as Promise<R>;
  return {
    locator: (selector) => at({ selector }),
    nth: (index) => at({ nth: index }),
    first: () => at({ first: true }),
    filter: (options) => at({ filter: { hasText: wireMatch(options?.hasText), hasNotText: wireMatch(options?.hasNotText) } }),
    all: async () => {
      const count = Number(await steps.value('count', [], chain));
      return Array.from({ length: count }, (_, index) => at({ nth: index }));
    },
    count: () => read('count', []),
    click: (options) => done('click', [options]),
    fill: (text, options) => done('fill', [text, options]),
    press: (key, options) => done('press', [key, options]),
    check: (options) => done('check', [options]),
    uncheck: (options) => done('uncheck', [options]),
    scrollIntoViewIfNeeded: (options) => done('scrollIntoViewIfNeeded', [options]),
    waitFor: (options) => done('waitFor', [options]),
    isVisible: (options) => read('isVisible', [options]),
    isEnabled: (options) => read('isEnabled', [options]),
    isDisabled: (options) => read('isDisabled', [options]),
    boundingBox: (options) => read('boundingBox', [options]),
    getAttribute: (name, options) => read('getAttribute', [name, options]),
    textContent: (options) => read('textContent', [options]),
    innerHTML: (options) => read('innerHTML', [options]),
    screenshot: (options) => steps.buffer('screenshot', [options], chain),
    evaluate: ((fn: unknown, arg?: unknown) => read('evaluate', [wireFunction(fn), arg])) as BrowserLocator['evaluate'],
    evaluateAll: ((fn: unknown) => read('evaluateAll', [wireFunction(fn)])) as BrowserLocator['evaluateAll'],
  };
}

function remotePage(steps: Steps): BrowserPage {
  const done = async (op: string, args: unknown[]) => {
    await steps.value(op, args);
  };
  return {
    goto: (url, options) => done('goto', [url, options]),
    url: () => steps.url(),
    title: () => steps.value('title', []) as Promise<string>,
    setContent: (html, options) => done('setContent', [html, options]),
    setViewportSize: (size) => done('setViewportSize', [size]),
    locator: (selector) => remoteLocator(steps, [{ selector }]),
    getByRole: (role, options) => remoteLocator(steps, [{ role, name: wireMatch(options?.name), exact: options?.exact }]),
    getByTestId: (testId) => remoteLocator(steps, [{ testId: wireMatch(testId) ?? '' }]),
    getByLabel: (text, options) => remoteLocator(steps, [{ label: wireMatch(text) ?? '', exact: options?.exact }]),
    keyboard: { press: (key, options) => done('keyboard.press', [key, options]) },
    waitForTimeout: (ms) => done('waitForTimeout', [ms]),
    waitForLoadState: (state, options) => done('waitForLoadState', [state, options]),
    waitForSelector: (selector, options) => done('waitForSelector', [selector, options]),
    waitForFunction: ((fn: unknown, arg?: unknown, options?: unknown) => done('waitForFunction', [wireFunction(fn), arg, options])) as BrowserPage['waitForFunction'],
    waitForEvent: () => notOverTheWire('download'),
    route: () => notOverTheWire('route'),
    evaluate: ((fn: unknown, arg?: unknown) => steps.value('evaluate', [wireFunction(fn), arg])) as BrowserPage['evaluate'],
    screenshot: (options) => steps.buffer('screenshot', [options]),
    pdf: (options) => steps.buffer('pdf', [options]),
  };
}
