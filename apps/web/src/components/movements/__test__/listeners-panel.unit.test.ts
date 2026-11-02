import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ListenersPanel, type ListenerSummary, type ListenersPanelProps } from "../listeners-panel";

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
