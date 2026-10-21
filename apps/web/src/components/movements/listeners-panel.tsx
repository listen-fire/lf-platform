"use client";

/**
 * The workbench's "Listeners" section. A listener is one `listen` line in
 * the script — the script is the source of truth, so this panel is a
 * projection of the CURRENT editor text, decorated with what the server
 * derived from the last save (trigger id, inbound address).
 *
 * Pause/resume therefore EDIT THE SCRIPT: pausing comments the listen
 * line out (prefix `# `) and saves; resuming uncomments it and saves.
 * There is no separate on/off switch to drift out of sync with the text.
 *
 * Three card states:
 *   - Listening      — the listen line exists and the last save derived it;
 *   - Will start on save — the line exists in the editor but hasn't been
 *     saved yet;
 *   - Paused         — a commented-out listen line.
 *
 * A movement with no listener at all gets a gentle suggestion card built
 * from the checker's info diagnostic, with a one-click "Add listener".
 */

import { useMemo, useState } from "react";
import { Check, Copy, Pause, Play, Plus } from "lucide-react";
import { expressionOfSlot } from 'movement-lang';
import { MovementParseError, parseProgram } from 'movement-lang';
import type { ExprSlot, ListenDeclaration, Program } from "movement-lang";

import { ServiceIcon } from "@/components/service-icon";

// ── Reading the script's listeners ──────────────────────────────────────────

/** What the server derived from the last save (movement.get / movement.save). */
export interface ListenerSummary {
  triggerId: string;
  /** The lane this listener runs as — the activity view filters by it. Null
   *  for a listener a save just provisioned, whose lane the page hasn't
   *  loaded yet. */
  name: string | null;
  /** The channel — source adapter slug (e.g. "email"). */
  kind: string;
  configKey: string | null;
  /** `<local>+<key>@<domain>` for adapters with an inbound routing key, else null. */
  inboundAddress: string | null;
  movementName: string | null;
}

export interface ActiveListen {
  instance: string;
  /** Adapter slug from the instance's construction, when resolvable. */
  adapter: string | null;
  configKey: string | null;
  movement: string;
  /** 1-based source lines the statement spans. */
  startLine: number;
  endLine: number;
}

export interface PausedListen {
  instance: string;
  configKey: string | null;
  movement: string;
  /** 1-based source lines of the commented-out statement. */
  startLine: number;
  endLine: number;
}

/** A config value's normalised string — read from the parsed AST, so quoting
 *  (single or double) is handled by the language's own string parser, not a
 *  regex. Non-string values (e.g. a `type: <…>` ref) fall back to their raw
 *  spelling, which is what the server's surface key uses for those. */
function configValueString(slot: ExprSlot): string {
  try {
    const expr = expressionOfSlot(slot);
    if (expr.type === "static" && typeof expr.value === "string") return expr.value;
  } catch {
    // not parseable as an expression — fall through to the raw spelling
  }
  return slot.raw.trim();
}

// Mirrors the server's SURFACE discriminator (provision.ts
// surfaceConfigKeyOf): inbound-routing-key listens route by `key`, kg
// listens by the watched `type`, cron listens by their `schedule`. The
// server row match below depends on both sides spelling this the same
// way — `key`-only here left cron/kg listeners permanently "Starts on
// save" (their server rows carry a configKey the script never matched).
function configKeyOf(listen: ListenDeclaration): string | null {
  for (const name of ["key", "type", "schedule"]) {
    const arg = listen.config.find((a) => a.name === name);
    if (arg) return configValueString(arg.value);
  }
  return null;
}

/** instance name → adapter slug, via the program's constructions
 *  (`source = email(credentials: …)`), import aliases resolved. */
function instanceAdapters(program: Program): Map<string, string> {
  const importOriginals = new Map<string, string>();
  const adapters = new Map<string, string>();
  for (const statement of program.statements) {
    if (statement.kind === "import") {
      for (const { name, alias } of statement.names) {
        if (alias !== undefined) importOriginals.set(alias, name);
      }
    } else if (statement.kind === "assign" && statement.value.kind === "construct") {
      const callee = statement.value.construct.callee;
      adapters.set(statement.name, importOriginals.get(callee) ?? callee);
    }
  }
  return adapters;
}

function parseLenient(source: string): Program | null {
  try {
    return parseProgram(source);
  } catch (e) {
    if (e instanceof MovementParseError) return null;
    throw e;
  }
}

/** instance name → adapter slug for the whole script (paused listens still
 *  name a live construction); null when the text doesn't parse. */
export function instanceAdaptersOf(source: string): Map<string, string> | null {
  const program = parseLenient(source);
  return program ? instanceAdapters(program) : null;
}

/** The script's live `listen` statements; null when the text doesn't parse. */
export function activeListensOf(source: string): ActiveListen[] | null {
  const program = parseLenient(source);
  if (!program) return null;
  const adapters = instanceAdapters(program);
  return program.statements
    .filter((s): s is ListenDeclaration => s.kind === "listen")
    .map((listen) => ({
      instance: listen.instance,
      adapter: adapters.get(listen.instance) ?? null,
      configKey: configKeyOf(listen),
      movement: listen.movement,
      startLine: listen.span.start.line,
      endLine: listen.span.end.line,
    }));
}

const COMMENT_PREFIX = /^(\s*)#\s?/;
const COMMENTED_LISTEN_START = /^\s*#\s?listen\s/;
const MAX_LISTEN_LINES = 10;

/**
 * Paused listeners: commented-out lines that, uncommented, parse as a
 * single `listen` statement. Multi-line listens are handled by growing
 * the window until the snippet parses.
 */
export function pausedListensOf(source: string): PausedListen[] {
  const lines = source.split("\n");
  const paused: PausedListen[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!COMMENTED_LISTEN_START.test(lines[i])) continue;
    for (let j = i; j < Math.min(i + MAX_LISTEN_LINES, lines.length); j++) {
      if (!COMMENT_PREFIX.test(lines[j])) break;
      const snippet = lines
        .slice(i, j + 1)
        .map((line) => line.replace(COMMENT_PREFIX, "$1"))
        .join("\n");
      const listen = parseLoneListen(snippet);
      if (listen) {
        paused.push({
          instance: listen.instance,
          configKey: configKeyOf(listen),
          movement: listen.movement,
          startLine: i + 1,
          endLine: j + 1,
        });
        i = j; // consume the block
        break;
      }
    }
  }
  return paused;
}

function parseLoneListen(snippet: string): ListenDeclaration | null {
  try {
    const program = parseProgram(snippet);
    const [only] = program.statements;
    return program.statements.length === 1 && only?.kind === "listen" ? only : null;
  } catch (e) {
    if (e instanceof MovementParseError) return null;
    throw e;
  }
}

// ── Editing the script (pause / resume / add) ───────────────────────────────

/** Pause: prefix `# ` to every line of the listen statement. */
export function commentListenLines(
  source: string,
  span: { startLine: number; endLine: number },
): string {
  const lines = source.split("\n");
  for (let i = span.startLine - 1; i <= span.endLine - 1 && i < lines.length; i++) {
    lines[i] = `# ${lines[i]}`;
  }
  return lines.join("\n");
}

/** Resume: strip the comment prefix from every line of the paused block. */
export function uncommentListenLines(
  source: string,
  span: { startLine: number; endLine: number },
): string {
  const lines = source.split("\n");
  for (let i = span.startLine - 1; i <= span.endLine - 1 && i < lines.length; i++) {
    lines[i] = lines[i].replace(COMMENT_PREFIX, "$1");
  }
  return lines.join("\n");
}

/** The ready-to-paste listen line inside a MOV_LISTEN_MISSING message. */
export function suggestedListenLine(message: string): string | null {
  const match = /e\.g\.\s+(listen\s+.+)$/.exec(message);
  return match ? match[1].trim() : null;
}

// ── The panel ───────────────────────────────────────────────────────────────

function channelLabel(slug: string): string {
  return slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface ListenersPanelProps {
  /** Current editor text (null while the editor is still loading). */
  source: string | null;
  /** Listeners the server derived from the last save. */
  serverListeners: ListenerSummary[];
  /** MOV_LISTEN_MISSING info messages from the live checker. */
  suggestionMessages: string[];
  saving: boolean;
  onPause: (listen: ActiveListen) => void;
  onResume: (paused: PausedListen) => void;
  onAddListener: (line: string) => void;
  /** Show this lane's runs and arrivals — the activity reading of the same
   *  movement, filtered to one listener. */
  onOpenActivity: (lane: string) => void;
}

export function ListenersPanel(props: ListenersPanelProps) {
  const { source, serverListeners } = props;

  const active = useMemo(
    () => (source !== null ? activeListensOf(source) : null),
    [source],
  );
  const paused = useMemo(
    () => (source !== null ? pausedListensOf(source) : []),
    [source],
  );
  const adapters = useMemo(
    () => (source !== null ? instanceAdaptersOf(source) : null),
    [source],
  );

  // "Nothing runs this movement" suggestions — but a PAUSED listener for
  // the movement already answers that (resume it), so those are filtered.
  const suggestions = useMemo(() => {
    const lines = props.suggestionMessages
      .map(suggestedListenLine)
      .filter((line): line is string => line !== null)
      .filter((line) => {
        const listen = parseLoneListen(line);
        return !paused.some((p) => p.movement === (listen?.movement ?? null));
      });
    return Array.from(new Set(lines));
  }, [props.suggestionMessages, paused]);

  // Match each script listener to a server-derived row (one-to-one, in
  // order) for its trigger-side details: channel + inbound address.
  const matched = useMemo(() => {
    const remaining = [...serverListeners];
    return (active ?? []).map((listen) => {
      const index = remaining.findIndex(
        (s) => s.movementName === listen.movement && s.configKey === listen.configKey,
      );
      const server = index >= 0 ? remaining.splice(index, 1)[0] : null;
      return { listen, server };
    });
  }, [active, serverListeners]);

  const empty =
    (active === null || active.length === 0) && paused.length === 0 && suggestions.length === 0;

  // With `listen` as the only invoker, a file with no triggers still runs
  // — on demand, or only when another automation calls it — so the
  // empty state suggests both the live and the on-demand (manual-channel)
  // wiring instead of implying the file is broken.

  return (
    <section data-testid="listeners-panel">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">
        Listeners
      </h2>

      <div className="space-y-3">
        {matched.map(({ listen, server }, i) => {
          const lane = server?.name ?? null;
          return (
            <ListenerCard
              key={`active-${i}`}
              kind={server?.kind ?? listen.adapter}
              movement={listen.movement}
              configKey={listen.configKey}
              inboundAddress={server?.inboundAddress ?? null}
              status={server ? "listening" : "pending"}
              {...(lane !== null
                ? { onOpenActivity: () => props.onOpenActivity(lane) }
                : {})}
              action={{
                label: "Pause",
                icon: Pause,
                disabled: props.saving,
                onClick: () => props.onPause(listen),
              }}
            />
          );
        })}

        {paused.map((listen, i) => (
          <ListenerCard
            key={`paused-${i}`}
            kind={adapters?.get(listen.instance) ?? null}
            movement={listen.movement}
            configKey={listen.configKey}
            inboundAddress={null}
            status="paused"
            action={{
              label: "Resume",
              icon: Play,
              disabled: props.saving,
              onClick: () => props.onResume(listen),
            }}
          />
        ))}

        {active === null && serverListeners.length > 0 && (
          <p className="text-[12px] leading-relaxed text-gray-400">
            The script doesn&apos;t parse right now, so listeners can&apos;t be
            managed — the saved ones keep running. Fix the problems below to
            pick this back up.
          </p>
        )}

        {suggestions.map((line) => (
          <div
            key={line}
            className="rounded-xl border border-primary-100 bg-primary-50/60 px-4 py-3.5"
            data-testid="listener-suggestion"
          >
            <div className="text-[12.5px] font-medium text-primary-800">
              Nothing runs this movement yet
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-primary-700">
              Add a listener so events on your channel fire it:
            </p>
            <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded-lg bg-white/70 px-2.5 py-1.5 font-mono text-[11px] text-primary-900">
              {line}
            </code>
            <button
              type="button"
              onClick={() => props.onAddListener(line)}
              className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-primary-600 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-primary-700"
              data-testid="add-listener"
            >
              <Plus size={13} />
              Add listener
            </button>
          </div>
        ))}

        {empty && (
          <p className="text-[12px] leading-relaxed text-gray-400">
            No triggers yet — this automation runs on demand or is imported
            by other automations. Add a{" "}
            <span className="font-mono text-[11px]">listen</span> line to run a
            movement on events, or{" "}
            <span className="font-mono text-[11px]">
              go = manual(); listen to go {"{}"} fire …
            </span>{" "}
            to run it on demand.
          </p>
        )}
      </div>

      {(matched.length > 0 || paused.length > 0) && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-gray-400">
          Pausing edits your script — the listen line is commented out and the
          script is saved. Resume uncomments it.
        </p>
      )}
    </section>
  );
}

const STATUS_STYLES = {
  listening: { classes: "bg-green-50 text-green-700", label: "Listening" },
  pending: { classes: "bg-amber-50 text-amber-700", label: "Starts on save" },
  paused: { classes: "bg-gray-100 text-gray-500", label: "Paused" },
} as const;

function ListenerCard(props: {
  kind: string | null;
  movement: string;
  configKey: string | null;
  inboundAddress: string | null;
  status: keyof typeof STATUS_STYLES;
  /** Open the activity reading filtered to this lane — server-derived
   *  listeners only; pending/paused ones have no history yet. */
  onOpenActivity?: () => void;
  action: {
    label: string;
    icon: typeof Pause;
    disabled: boolean;
    onClick: () => void;
  };
}) {
  const status = STATUS_STYLES[props.status];
  const ActionIcon = props.action.icon;
  const muted = props.status === "paused";
  return (
    <div
      className={`rounded-xl border px-4 py-3.5 ${
        muted ? "border-gray-100 bg-gray-50/60" : "border-gray-100 bg-white"
      }`}
      data-testid={`listener-card-${props.status}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
              muted ? "bg-gray-100 text-gray-400" : "bg-primary-50 text-primary-600"
            }`}
          >
            <ServiceIcon
              type={(props.kind ?? "").toUpperCase()}
              className="h-4 w-4"
            />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium text-gray-900">
              {props.kind ? channelLabel(props.kind) : "Channel"}
            </div>
            <div className="truncate text-[11.5px] text-gray-400">
              Runs <span className="font-mono text-[11px]">{props.movement}</span>
            </div>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${status.classes}`}
        >
          {status.label}
        </span>
      </div>

      {(props.configKey !== null || props.inboundAddress !== null) && (
        <dl className="mt-3 space-y-1.5">
          {props.configKey !== null && (
            <DetailRow label="Routing key">
              <span className="font-mono text-[11px] text-gray-700">
                {props.configKey}
              </span>
            </DetailRow>
          )}
          {props.inboundAddress !== null && (
            <DetailRow label="Inbound address">
              <CopyableValue value={props.inboundAddress} />
            </DetailRow>
          )}
        </dl>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        {props.onOpenActivity ? (
          <button
            type="button"
            onClick={props.onOpenActivity}
            className="text-[12px] font-medium text-gray-500 transition-colors hover:text-primary-700"
            data-testid="listener-open"
          >
            Runs &amp; activity →
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          disabled={props.action.disabled}
          onClick={props.action.onClick}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] font-medium text-gray-600 hover:border-gray-300 hover:text-gray-900 disabled:opacity-50"
          data-testid={`listener-${props.action.label.toLowerCase()}`}
        >
          <ActionIcon size={12} />
          {props.action.label}
        </button>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-[11.5px] text-gray-400">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      title="Copy"
      className="group flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-gray-50"
    >
      <span className="truncate font-mono text-[11px] text-gray-700">{value}</span>
      {copied ? (
        <Check size={12} className="shrink-0 text-green-600" />
      ) : (
        <Copy size={12} className="shrink-0 text-gray-300 group-hover:text-gray-500" />
      )}
    </button>
  );
}
