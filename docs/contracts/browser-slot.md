# The browser slot

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

Some web reading needs a real browser: a deck behind a share link's email form, a viewer that draws its slides with script, a page printed to PDF. A host that can run one fills the browser slot; a module asks for a page through its context (`ctx.browser`). The engine never sees it.

## Who fills it

| host | the slot |
|---|---|
| the platform, `api` image (`ghcr.io/listen-fire/api`) | `@lf/chromium`: a headless Chromium launched through Playwright |
| the platform, `api-slim` image | empty: the image carries no Chromium |
| lf, `serve-module` | empty unless `core: { browser: <module> }` names a browser module (a process or a remote url): lf builds none in, and hands the named one's address to the modules it starts (`LF_BROWSER_URL`, `LF_BROWSER_TOKEN`), whose `serve-module` fills `ctx.browser` with a client of it |
| an embedder | whatever it lends a module it loads (`ModuleHost.browser`, `serveModule({ browser })`); empty when it lends none |

An empty slot refuses every page, naming the slot and why it is empty, e.g. `the browser slot is empty: this is the api-slim image, which carries no Chromium; run the api image (ghcr.io/listen-fire/api, build target api-browser) to fill it`. A module can read why before asking (`ctx.browser.emptyBecause`), so a read that swallows its errors still refuses by name.

## What a module gets

`withPage(fn, options?)` opens a page in a fresh browser, runs `fn(page, session)`, and closes the browser when `fn` settles. `options` sets the viewport and the user agent.

- **The page** is the part of a browser automation API the modules use, written down as an interface (`BrowserPage` in [`browser.ts`](../../packages/module-runtime/browser.ts)): open an address, read its title and URL, find elements by selector, role, label or test id, click and fill them, wait for a load state or a selector, hold requests with a route, wait for a download, take a screenshot of the page or an element (PNG), and print the page to PDF. Playwright's `Page` is one; a remote browser service speaking the same protocol is another. A module that needs more adds it there first.
- **The session** can be closed early (`session.close()`); the slot closes it in any case.

## Limits

Each slot bounds its own sessions, not its callers:

- **At most 2 sessions at once.** Each is a whole browser process. The rest wait for a place.
- **5 minutes per session, launch included.** A session past that is refused (`BrowserSessionTimedOut`) and its browser is closed, whatever the page is doing.
- **10 seconds to close.** A browser that does not close in time is abandoned, so its place is freed.

On the platform the gated-document reader, PDF rendering and the legacy Slack preview share one set of sessions.

## Who uses it

`@lf/web`'s gated-document reader (`fetch-url`, `vc-url-retrieval`): DocSend, Pitch, Canva, Google Slides and Docs, Papermark, BriefLink, Tome, Figma (off by default), and Notion. With the slot filled, a document is read and kept in the host's files (`ctx.files`); with it empty, a gated address fails naming the slot. A plain PDF, PowerPoint or spreadsheet link needs no browser.

## The methods (a browser module over the wire)

A browser module is a protocol-2 server ([the transport](adapter-protocol.md#transport)) holding sessions open between calls. Shapes: `engine-contracts/slots/browser.ts`; the server and client: `browserSlotAnswer` and `remoteBrowserSlot` (`@listen-fire/module-runtime/module-wire`, re-exported by `movement-engine/public/module-wire`).

| method | params | result |
|---|---|---|
| `browser.open` | `{ viewport?, userAgent? }`; waits for a place | `{ session, deadlineMs }`: the session lasts at most `deadlineMs` |
| `browser.page` | `{ session, op, args, locator? }` | `{ value?, bytes?, url }` |
| `browser.close` | `{ session }` | `null` |

- **`op`** is a page step (`goto`, `title`, `setContent`, `waitForLoadState`, `evaluate`, `screenshot`, `pdf`, …) or, with `locator`, an element step (`click`, `fill`, `textContent`, `count`, `screenshot`, …).
- **`locator`** is a chain read afresh on every step: `{ selector }`, `{ role, name?, exact? }`, `{ testId }` or `{ label, exact? }` first, then `{ nth }`, `{ first: true }` or `{ filter: { hasText?, hasNotText? } }`. A regex is `{ regex, flags }`.
- **A function** the page runs crosses as `{ source }` (its text). **Bytes** (a screenshot, a PDF) come back base64 in `bytes`. **`url`** is the page's address after the step.
- **Not over the wire:** `route` and `waitForEvent('download')`. A module that needs them is served in the browser's own process.
- **Limits stay the server's.** A client is refused (`BrowserSessionTimedOut`) once `deadlineMs` passes, and an unknown or ended session is refused with `session_closed`.

## Contract suite

[`contract.ts`](../../packages/movement-engine/services/browser/contract.ts) holds every module filling the slot to the same cases: open a page and read it, screenshot the page and an element, print to PDF, pass on what the session answers or throws, close early, wait for a place beyond the limit, refuse a session past its time. `@lf/chromium` passes it against a page on loopback (`apps/api/src/services/__test__/chromium_browser.unit.test.ts`); the scripted page the tests drive instead of a browser (`fakeBrowser`, `movement-engine/public/testing`) passes it in `services/browser/__test__`.

Over the wire, the same cases hold the scripted page served as a browser module, driven through the wire client (`apps/cli/src/__test__/slot_conformance.test.ts`).

## Changes

- **2026-10-19** (within adapter protocol 2): a browser module over the wire (`browser.open`, `browser.page`, `browser.close`); lf fills the slot with one named in `core:` and hands it to the modules it starts.
