import { createRoot } from "react-dom/client";

import { STORY_RESULT_META_KEY } from "platform-constants/story_app";
import { connectToHost, type HostContext, type ToolResult } from "./app-host";
import { StoryPage } from "./page";
import type { StoryView } from "../view";

/**
 * The IN-CHAT MOUNT — the same board, drawn inside the conversation.
 *
 * The third mount of one renderer: the workbench panel, the link page, and
 * this. It draws whatever story the host hands it and knows nothing else —
 * no fetching, no session, no second round trip, because the sandbox around
 * an app blocks every request it could make.
 *
 * TWO ARRIVALS, ONE WINNER. A fresh call's result rides the live
 * `ui/notifications/tool-result` push — the spec's one defined channel,
 * timed by real tool-execution latency, which is why the race below has
 * never shown up on a fresh call. Reopening a chat mounts this same view for
 * a call that already finished — no execution to wait through, no spec
 * provision for the replay either (`tool-result` is only "MUST send... if
 * the View is displayed during tool execution") — so a host answering that
 * gap may push the notification before this script's own listener exists
 * (unrecoverable: a message sent to nobody is gone), or fold it into the
 * `ui/initialize` reply instead (`HostContext.toolResult`, see `app-host`).
 * Either can arrive in either order, so the FIRST story wins and nothing
 * after it — a duplicate, a bare link body, whatever — changes the panel.
 *
 * DEGRADES TO THE LINK. If no story ever arrives — an older host, a result
 * whose metadata was genuinely dropped, an automation we couldn't read —
 * this shows the link the tool has always returned. Never a blank panel:
 * blank is the one outcome worse than the text-and-link we shipped before.
 *
 */

const ROOT_ID = "story-root";

type Panel =
  | { phase: "waiting" }
  | { phase: "story"; view: StoryView }
  | { phase: "link"; name?: string; storyUrl?: string };

function AppPanel({ panel, onOpen }: { panel: Panel; onOpen: (url: string) => void }) {
  if (panel.phase === "story") return <StoryPage view={panel.view} />;
  if (panel.phase === "waiting") return <Card line="Drawing the picture…" />;
  return (
    <Card
      name={panel.name}
      line={
        panel.storyUrl
          ? "The picture of what it does opens in your browser."
          : "There’s no picture to show for this one."
      }
      action={
        panel.storyUrl
          ? { label: "Open the picture", run: () => onOpen(panel.storyUrl!) }
          : undefined
      }
    />
  );
}

/** Everything that isn't the board: the wait, and the fallback to the link. */
function Card({
  name,
  line,
  action,
}: {
  name?: string;
  line: string;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="flex h-full flex-col justify-center bg-white px-6 py-5">
      <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-primary-500">
        Listen-Fire
      </span>
      <h1 className="mt-2 text-[15px] font-medium text-gray-900">
        {name ?? "This automation"}
      </h1>
      <p className="mt-1 text-[13px] text-gray-500">{line}</p>
      {action ? (
        <button
          type="button"
          onClick={action.run}
          className="mt-4 self-start rounded-md bg-primary-500 px-3 py-1.5 text-[13px] font-medium text-white"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Read the story out of the result — and, failing that, enough of it to offer
 * the link. The tool's text content is the automation as the agent sees it,
 * so the fallback needs no extra field: it reads the same body.
 */
function readResult(result: ToolResult): Panel {
  const story = result._meta?.[STORY_RESULT_META_KEY];
  if (story) return { phase: "story", view: story as StoryView };

  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) return { phase: "link" };
  try {
    const body = JSON.parse(text) as { name?: string; storyUrl?: string };
    return { phase: "link", name: body.name, storyUrl: body.storyUrl };
  } catch {
    return { phase: "link" };
  }
}

/**
 * `containerDimensions` collapses to one of three modes (SEP-1865's size
 * contract): a number on `height` means the host is authoritative and wants
 * us to fill it; a number on `maxHeight` alone means WE choose, capped there;
 * neither means we choose outright.
 */
type HeightMode = "fixed" | "flexible" | "unbounded";

function heightMode(dimensions: HostContext["containerDimensions"]): HeightMode {
  if (dimensions && typeof dimensions.height === "number") return "fixed";
  if (dimensions && typeof dimensions.maxHeight === "number") return "flexible";
  return "unbounded";
}

/**
 * The board's desired height. Its canvas scrolls internally on both axes, so
 * there is no natural content height to measure — this is a deliberate ask,
 * not a measurement: enough room for a typical board, capped so we never
 * demand an ungainly slice of the chat. A flexible host sets the real
 * ceiling and we never ask past it; an unbounded one gets this figure
 * outright.
 */
const MIN_STORY_HEIGHT = 320;
const PREFERRED_STORY_HEIGHT = 640;
const MAX_STORY_HEIGHT = 720;

function desiredStoryHeight(mode: HeightMode, maxHeight: number | undefined): number {
  if (mode === "flexible" && typeof maxHeight === "number") {
    return Math.min(PREFERRED_STORY_HEIGHT, maxHeight);
  }
  return Math.max(MIN_STORY_HEIGHT, Math.min(PREFERRED_STORY_HEIGHT, MAX_STORY_HEIGHT));
}

/**
 * The mount's height, always a concrete value — never a `%` left to chain
 * through an ancestor whose own height may not be definite inside a
 * host-sized iframe. Fixed mode fills what the host gave us; the cards
 * (waiting, link fallback) carry real text and size themselves; only the
 * story panel gets an explicit ask, because its canvas has no size of its
 * own to report.
 */
function heightStyle(phase: Panel["phase"], mode: HeightMode, maxHeight: number | undefined): string {
  if (mode === "fixed") return "100%";
  if (phase !== "story") return "auto";
  return `${desiredStoryHeight(mode, maxHeight)}px`;
}

const mount = document.getElementById(ROOT_ID);

if (mount) {
  const host = connectToHost({ name: "Listen-Fire automation story", version: "1.0.0" });
  const root = createRoot(mount);

  let phase: Panel["phase"] = "waiting";
  let mode: HeightMode = "unbounded";
  let maxHeight: number | undefined;
  let lastReported: { width: number; height: number } | undefined;

  const applyHeight = () => {
    mount.style.height = heightStyle(phase, mode, maxHeight);
  };

  // NOT `document.documentElement.clientHeight`: per the CSSOM View spec the
  // root element's `client*` always reports the VIEWPORT size (the iframe's
  // current box), never its own set height — so reading it back after
  // `applyHeight` just echoes the size we already have. `#story-root` is an
  // ordinary descendant; its `getBoundingClientRect` is the real, unclamped
  // layout size, which is what the host needs to grow the iframe TO.
  const reportIfChanged = () => {
    const box = mount.getBoundingClientRect();
    const width = Math.round(box.width);
    const height = Math.round(box.height);
    if (lastReported && lastReported.width === width && lastReported.height === height) return;
    lastReported = { width, height };
    host.reportSize(width, height);
  };

  // rAF-debounced: coalesce a burst of layout changes (a React commit, a
  // font swap, the observer's own callback) into one report per frame, and
  // never repeat an unchanged size.
  let reportScheduled = false;
  const scheduleReport = () => {
    if (reportScheduled) return;
    reportScheduled = true;
    requestAnimationFrame(() => {
      reportScheduled = false;
      reportIfChanged();
    });
  };

  // The spec's own recommendation for `size-changed`: observe the real
  // content root rather than trust any one call site to catch every change
  // that can grow or shrink it.
  new ResizeObserver(scheduleReport).observe(mount);

  // FIRST STORY WINS. Two independent, unordered channels can each hand us a
  // panel (see the file header) — once one of them is the real board, no
  // later arrival on either channel is allowed to replace it, whether that's
  // a stale duplicate or a bare link body a slower channel is still carrying.
  let hasStory = false;
  const draw = (panel: Panel) => {
    if (hasStory) return;
    if (panel.phase === "story") hasStory = true;
    phase = panel.phase;
    root.render(<AppPanel panel={panel} onOpen={(url) => host.openLink(url)} />);
    applyHeight();
    // Belt-and-braces beyond the observer: the story arrives on its own
    // schedule (the tool-result message, independent of `connect`), and a
    // React commit on this tick is not yet a laid-out, painted frame — wait
    // one to let the browser settle before sampling.
    requestAnimationFrame(scheduleReport);
  };

  draw({ phase: "waiting" });
  // Before connecting, always: the host may deliver the result the moment we
  // say we are ready, and a notification with no handler is simply lost.
  host.onToolResult((result) => draw(readResult(result)));

  void host.connect().then((context) => {
    const dimensions = context?.containerDimensions;
    mode = heightMode(dimensions);
    maxHeight = dimensions?.maxHeight;
    // The one thing a sandboxed app can't bring with it is a typeface. If the
    // host offers its own, take it — see `app.tailwind.config.cjs`.
    const font = context?.styles?.variables?.['--font-sans'];
    if (font) document.documentElement.style.setProperty('--app-font-sans', font);
    // The restore channel this reply can carry (see `HostContext.toolResult`
    // and the file header) — the one delivery path immune to the "dropped
    // before our listener existed" race, because it answers a request we
    // ourselves chose the timing of.
    if (context?.toolResult) draw(readResult(context.toolResult));
    applyHeight();
    scheduleReport();
  });
}
