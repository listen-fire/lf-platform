# The browser slot

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

Some web reading needs a real browser: a deck behind a share link's email form, a viewer that draws its slides with script, a page printed to PDF. A host that can run one fills the browser slot; a module asks for a page through its context (`ctx.browser`). The engine never sees it.

## Who fills it

| host | the slot |
|---|---|
| the platform, `api` image (`ghcr.io/listen-fire/api`) | `@lf/chromium`: a headless Chromium launched through Playwright |
| the platform, `api-slim` image | empty: the image carries no Chromium |
| lf, `serve-module` | empty: lf has no browser module, and `core: { browser: … }` is refused |
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

## Contract suite

[`contract.ts`](../../packages/movement-engine/services/browser/contract.ts) holds every module filling the slot to the same cases: open a page and read it, screenshot the page and an element, print to PDF, pass on what the session answers or throws, close early, wait for a place beyond the limit, refuse a session past its time. `@lf/chromium` passes it against a page on loopback (`apps/api/src/services/__test__/chromium_browser.unit.test.ts`); the scripted page the tests drive instead of a browser (`fakeBrowser`, `movement-engine/public/testing`) passes it in `services/browser/__test__`.
