import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ListenersPanel, runnableFromOutline, type ListenerSummary, type ListenersPanelProps } from "../listeners-panel";

const SOURCE = `import { email } from adapters

inbox = email()

movement Triage(item: <inbox-[:message]->>) {
}

listen to inbox { key: "deals" } fire Triage
`;

const served = (paused: ListenerSummary["paused"]): ListenerSummary => ({
  triggerId: "t1",
  name: "movement/deals/Triage",
  kind: "email",
  configKey: "deals",
  inboundAddress: null,
  movementName: "Triage",
  paused,
});

const panel = (serverListeners: ListenerSummary[]) => {
  const props: ListenersPanelProps = {
    source: SOURCE,
    serverListeners,
    suggestionMessages: [],
    saving: false,
    onPause: () => {},
    onResume: () => {},
    onAddListener: () => {},
    onResumeStopped: () => {},
    resuming: false,
    onOpenActivity: () => {},
  };
  return renderToStaticMarkup(createElement(ListenersPanel, props));
};

describe("a listener the platform stopped", () => {
  it("reads Listening, with Pause, while it runs", () => {
    const html = panel([served(null)]);
    expect(html).toContain('data-testid="listener-card-listening"');
    expect(html).toContain('data-testid="listener-pause"');
    expect(html).not.toContain("listener-stopped-reason");
  });

  it("reads Stopped, says why and what it held, and offers Resume instead of Pause", () => {
    const html = panel([served({ reason: "LISTEN_LOOP: deals:Triage is paused", held: 2 })]);
    expect(html).toContain('data-testid="listener-card-stopped"');
    expect(html).toContain("LISTEN_LOOP: deals:Triage is paused");
    expect(html).toContain("2 arrivals held since it stopped");
    expect(html).toContain('data-testid="listener-resume-stopped"');
    expect(html).not.toContain('data-testid="listener-pause"');
  });
});

describe("a listen on a traversal", () => {
  const TRAVERSAL = `graph = connect #kg

function onOrg(c: <graph-[:\`Organisation Change\`]->>) {
}

listen to graph-[:Organisation]->-[c:Changes WHERE c.Kind == "created"]-> fire onOrg
`;

  it("is titled by its address, not its module", () => {
    const props: ListenersPanelProps = {
      source: TRAVERSAL,
      serverListeners: [{ ...served(null), kind: "kg", configKey: "listen:f:onOrg:abc", movementName: "onOrg" }],
      suggestionMessages: [],
      saving: false,
      onPause: () => {},
      onResume: () => {},
      onAddListener: () => {},
      onResumeStopped: () => {},
      resuming: false,
      onOpenActivity: () => {},
    };
    const html = renderToStaticMarkup(createElement(ListenersPanel, props));
    expect(html).toContain('data-testid="listener-card-listening"');
    expect(html).toContain('graph-[:Organisation]-&gt;-[c:Changes WHERE c.Kind == &quot;created&quot;]-&gt;');
    expect(html).not.toContain(">Kg<");
  });

  it("keeps its address while paused", () => {
    const props: ListenersPanelProps = {
      source: TRAVERSAL.replace("listen to", "# listen to"),
      serverListeners: [],
      suggestionMessages: [],
      saving: false,
      onPause: () => {},
      onResume: () => {},
      onAddListener: () => {},
      onResumeStopped: () => {},
      resuming: false,
      onOpenActivity: () => {},
    };
    const html = renderToStaticMarkup(createElement(ListenersPanel, props));
    expect(html).toContain('data-testid="listener-card-paused"');
    expect(html).toContain('data-testid="listener-address"');
  });
});

describe("a text on a carried version, whose parser is on the server", () => {
  // The panel's own parser is the current release's, and it never reads this.
  const ZERO_TWELVE = "function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual fire echo\n";
  const carried = (serverOutline: ListenersPanelProps["serverOutline"], serverListeners: ListenerSummary[] = []) =>
    renderToStaticMarkup(
      createElement(ListenersPanel, {
        source: ZERO_TWELVE,
        serverOutline,
        serverListeners,
        suggestionMessages: [],
        saving: false,
        onPause: () => {},
        onResume: () => {},
        onAddListener: () => {},
        onResumeStopped: () => {},
        resuming: false,
        onOpenActivity: () => {},
      }),
    );
  const echo = { instance: "manual", configKey: null, address: null, movement: "echo", startLine: 4, endLine: 4 };

  it("shows what its own version read", () => {
    const html = carried({ active: [{ ...echo, adapter: null, traversal: false }], paused: [], adapters: {} });
    expect(html).toContain("echo");
    expect(html).toContain('data-testid="listener-card-pending"');
  });

  it("a version whose listens do not fire does not promise one on save", () => {
    const outline = { active: [{ ...echo, adapter: null, traversal: false }], paused: [], adapters: {} };
    const html = renderToStaticMarkup(
      createElement(ListenersPanel, {
        source: ZERO_TWELVE,
        serverOutline: outline,
        savedListensFire: false,
        serverListeners: [],
        suggestionMessages: [],
        saving: false,
        onPause: () => {},
        onResume: () => {},
        onAddListener: () => {},
        onResumeStopped: () => {},
        resuming: false,
        onOpenActivity: () => {},
      }),
    );
    expect(html).toContain("Not firing");
    expect(html).not.toContain("Starts on save");
  });

  it("shows a commented-out listen its own version read", () => {
    expect(carried({ active: [], paused: [echo], adapters: {} })).toContain('data-testid="listener-card-paused"');
  });

  it("says nothing until the first answer: neither no triggers nor does not parse", () => {
    const html = carried(null, [served(null)]);
    expect(html).not.toContain("No triggers yet");
    expect(html).not.toContain("doesn&#x27;t parse");
  });

  it("never teaches a later spelling when it has no listens", () => {
    const html = carried({ active: [], paused: [], adapters: {} });
    expect(html).toContain("No triggers yet");
    expect(html).not.toContain("go = manual()");
  });
});

describe("Run now on a text a carried version read", () => {
  const listen = (over: { instance: string; adapter: string | null }) => ({ configKey: null, address: null, movement: "m", startLine: 1, endLine: 1, traversal: false, ...over });

  it("is what the page loaded with until the first answer", () => {
    expect(runnableFromOutline(null, true)).toBe(true);
    expect(runnableFromOutline(null, false)).toBe(false);
  });

  it("the unit by name, or a connected manual channel under any alias", () => {
    const read = (active: ReturnType<typeof listen>[]) => runnableFromOutline({ active, paused: [], adapters: {} }, false);
    expect(read([listen({ instance: "manual", adapter: null })])).toBe(true);
    expect(read([listen({ instance: "go", adapter: "@lf/manual" })])).toBe(true);
    expect(read([listen({ instance: "inbox", adapter: "@lf/email" })])).toBe(false);
  });

  it("a text that does not parse cannot be run", () => {
    expect(runnableFromOutline({ active: null, paused: [], adapters: null }, true)).toBe(false);
  });
});

describe("the browser and a carried version's parser", () => {
  it("the web app imports no version package and has no slot for one: 0.12 text is parsed on the server", () => {
    const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const path = jest.requireActual<typeof import("node:path")>("node:path");
    const SRC = path.resolve(__dirname, "../../../");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__test__") walk(full);
        } else if (/\.tsx?$/.test(entry.name) && /from ['"]@listen-fire\/(lang-|language-versions)/.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(full);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it("the shared tRPC types name no version package either", () => {
    const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const path = jest.requireActual<typeof import("node:path")>("node:path");
    const types = fs.readFileSync(path.resolve(__dirname, "../../../../../../packages/trpc/types.ts"), "utf8");
    expect(types).not.toMatch(/@listen-fire\/(lang-|language-versions)/);
  });
});
