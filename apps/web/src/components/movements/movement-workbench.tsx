"use client";

// The movement editor workbench, shared by `/movements/new` and
// `/movements/[id]`.
//
// The script text is what's saved — saving always keeps your text, even
// when it has problems. A clean save also makes the movement live; a save
// with problems keeps it as a draft (any previously live version keeps
// running until a clean save replaces it).
//
// The catalog arrives in two tiers:
//   1. a fast SKELETON (adapters, credentials, plugins, your data model —
//      no instance schemas), fetched once — the editor opens against it;
//   2. the snapshot TYPED FOR THE CURRENT SCRIPT (`catalogForSource`), which
//      replaces it. That call runs the same routine `save` runs, so the
//      editor and the compiler cannot disagree about the same text. The
//      checker is silent on unknown schemas, so problems only ever TIGHTEN
//      as it lands — no error flicker.
// Validation, autocomplete, and hover all run in the browser against it.
//
// Tier 2 is one call for the WHOLE script, not one per construction, because
// the questions that matter are not per-pair: which entry position an instance
// was constructed at, and how the script narrows it. Asking per-pair could
// express neither, so a positioned or narrowed instance got typed against the
// bare connection — and for a container-shaped system (sheets, airtable) that
// meant the editor erroring on a script's own table while `save` compiled it.
//
// `describeInstance` survives for the one question that IS per-pair and has no
// script behind it: the /movements/new starter, picking a first position.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  Loader2,
  PanelRight,
  Paperclip,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { mergeInstanceSchema, type CatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { constructionKey, type ConstructionRef, type DefinitionTarget, type MovementDiagnostic } from 'legacy-lang';

import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  LanguageVersionNotice,
  type UpgradeDiagnostic,
} from "@/components/movements/language-version";
import { TAB_ORIGIN_ID } from "@/lib/tab-origin";
import {
  MovementEditor,
  type MovementEditorHandle,
} from "@/components/movements/movement-editor";
import type { CheckRemote, EditorLanguageRoute } from "@/components/movements/editor-lint";
import { runConnectAction } from "@/components/movements/connect-actions";
import { MovementStory } from "@/components/movements/story/movement-story";
import {
  MovementActivity,
  LANE_PARAM,
  STATUS_PARAM,
} from "@/components/movements/movement-activity";
import {
  ListenersPanel,
  commentListenLines,
  uncommentListenLines,
  type ListenerSummary,
} from "@/components/movements/listeners-panel";
import { readFileAsBase64, type PickedFile } from "@/lib/picked-file";

const VIM_PREFERENCE_KEY = "listen-fire.movements.vim";
const WRAP_PREFERENCE_KEY = "listen-fire.movements.wrap";

/** Which reading of the movement the page is showing. Absent is the code
 *  editor, which is where this pane opens. */
const VIEW_PARAM = "view";
const STORY_VIEW = "story";
const ACTIVITY_VIEW = "activity";

type WorkbenchView = "code" | typeof STORY_VIEW | typeof ACTIVITY_VIEW;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FALLBACK_SOURCE = `# A movement reacts to each new item from a source and writes the
# results wherever they belong. Start by importing what it touches:
#
#   import { email } from adapters
#   import { my_inbox } from credentials
#
# Connect a source under Credentials to get started.
`;

function starterSource(snapshot: CatalogSnapshot): string {
  const credentialEntry = Object.entries(snapshot.credentials)[0];
  if (!credentialEntry) return FALLBACK_SOURCE;
  const [credentialName, cred] = credentialEntry;
  // A catalog credential names its adapter as either `{ adapter }` (legacy) or
  // `{ adapters: [...] }` (a credential that authenticates several adapters);
  // the starter uses the primary one.
  const adapter = "adapters" in cred ? cred.adapters[0] : cred.adapter;
  if (adapter === undefined) return FALLBACK_SOURCE;
  const schemas = snapshot.adapters[adapter]?.schemas ?? {};
  const schema = schemas[credentialName] ?? Object.values(schemas)[0];
  const positions = Object.keys(schema?.positions ?? {});
  const position = positions.includes("message") ? "message" : positions[0];
  if (position === undefined) return FALLBACK_SOURCE;
  // A type names its edge as an address ('.' is for properties); a name that
  // isn't identifier-safe wears backticks, as anywhere else.
  const positionRef = /^[A-Za-z_]\w*$/.test(position) ? position : `\`${position}\``;
  // The listener makes the starter a complete automation: events on the
  // source fire the movement. Channels with routing keys get one.
  const listenConfig = snapshot.adapters[adapter]?.triggerConfig?.includes("key")
    ? ' { key: "my-movement" }'
    : "";
  return `import { ${adapter} } from adapters
import { ${credentialName} } from credentials

source = ${adapter}(credentials: ${credentialName})

movement my_movement(item: <source-[:${positionRef}]->>) {
  # describe what should happen for each ${position}
}

listen to source${listenConfig} fire my_movement
`;
}

// The library starter needs no credentials: a library is just exported
// movements and record structures — no listeners, nothing to construct up front.
const LIBRARY_STARTER_SOURCE = `# A library shares movements and record structures with other movement
# scripts. Mark a declaration with \`export\` to offer it — once saved,
# another script can write:
#
#   import { tidy_contact, Contact } from "<this file's saved name>"
#
# Declarations without \`export\` stay private to this file.

export node Contact {
  name: <text>
  email: <text>
}

export movement tidy_contact(p: <Contact>) {
  # work with each person here — read fields with backticks, e.g. p.\`name\`
}
`;

function offsetOf(source: string, loc: { line: number; col: number }): number {
  let offset = 0;
  let line = 1;
  while (line < loc.line) {
    const nl = source.indexOf("\n", offset);
    if (nl === -1) break;
    offset = nl + 1;
    line++;
  }
  return Math.min(offset + loc.col - 1, source.length);
}

export type MovementValidityStatus = "valid" | "invalid" | "unverified";

export function ValidityBadge({
  validityStatus,
}: {
  validityStatus: MovementValidityStatus | null;
}) {
  const styles = {
    valid: "bg-green-50 text-green-700",
    invalid: "bg-red-50 text-red-700",
    unverified: "bg-amber-50 text-amber-700",
    unchecked: "bg-gray-100 text-gray-600",
  } as const;
  const labels = {
    valid: "Live",
    invalid: "Has problems",
    unverified: "Couldn't verify",
    unchecked: "Not checked yet",
  } as const;
  const key = validityStatus ?? "unchecked";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[key]}`}
    >
      {labels[key]}
    </span>
  );
}

export interface MovementWorkbenchProps {
  /** Present on the edit page; absent on `/movements/new`. */
  movementId?: string;
  /** The saved script (edit page); new movements get a starter script. */
  initialSource?: string;
  /** The row's updatedAt at load (edit page) — base for the save-time
   *  concurrency guard. */
  initialUpdatedAt?: string | Date;
  movementName?: string;
  /** Runtime validity of the saved source at load (null = never checked). */
  initialValidityStatus?: MovementValidityStatus | null;
  /** Listeners the server derived from the last save (edit page). */
  initialListeners?: ListenerSummary[];
  /** The saved script declares a manual-channel listener — "Run now" is
   *  available (it injects an invocation event on that channel). */
  initialRunnable?: boolean;
  /** Scripts that import this file (edit page) — shown near the header so
   *  an edit to a shared library is made knowing who depends on it. */
  dependents?: Array<{ id: string; name: string }>;
  /** The saved movement's language version (edit page) — the editor checks
   *  the text as that version. Absent on `/movements/new` (the current one). */
  languageVersion?: LanguageVersion;
  /** How the server reads the saved movement's pin (edit page): whose checker
   *  lints it, and the dialect the language service reads it under. Absent on
   *  `/movements/new`, which takes the installed release's from the catalog. */
  languageRoute?: EditorLanguageRoute;
  /** What keeps the saved movement off the current language version (edit
   *  page); null when nothing does. */
  upgradeDiagnostics?: UpgradeDiagnostic[] | null;
  /** Which starter script `/movements/new` seeds: an automation with a
   *  listener, or a library with an exported movement + shape. */
  starter?: "automation" | "library";
}

/** "Used by" chips — the scripts that import this file, linked. Shown
 *  near the header so a library edit happens with its importers in view. */
/** Where a Run-now press stands: queued or running, waiting, or settled. */
function RunNowOutcome({
  movementName,
  status,
}: {
  movementName: string;
  status: RouterOutputs["views"]["movement"]["runStatus"] | undefined;
}) {
  if (status !== undefined && "error" in status) {
    return (
      <div className="rounded-xl border border-red-100 bg-red-50/70 px-4 py-3.5">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-red-800">
          <AlertCircle size={15} />
          Lost track of the run
        </div>
        <div className="mt-2 text-[12px] leading-relaxed text-red-700">{status.error}</div>
      </div>
    );
  }
  if (status === undefined || status.status === "running") {
    return (
      <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-4 py-3.5">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-gray-700">
          <Loader2 size={15} className="animate-spin" />
          Running &lsquo;{movementName}&rsquo;
        </div>
      </div>
    );
  }
  if (status.status === "parked") {
    return (
      <div className="rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-3.5">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-amber-800">
          <HelpCircle size={15} />
          &lsquo;{movementName}&rsquo; is waiting
        </div>
        <div className="mt-2 text-[12px] leading-relaxed text-amber-700">
          {status.paused?.reason ?? "It carries on once what it waits for arrives — see its runs."}
        </div>
      </div>
    );
  }
  if (status.status === "failed") {
    return (
      <div className="rounded-xl border border-red-100 bg-red-50/70 px-4 py-3.5">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-red-800">
          <AlertCircle size={15} />
          The run failed
        </div>
        <div className="mt-2 text-[12px] leading-relaxed text-red-700">
          {status.failureReason ?? "No reason was recorded."}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-green-100 bg-green-50/70 px-4 py-3.5">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-green-800">
        <CheckCircle2 size={15} />
        Ran &lsquo;{movementName}&rsquo;
        {status.dryRun ? " (rehearsal)" : ""}
      </div>
      <div className="mt-2 text-[12px] leading-relaxed text-green-700">
        {status.recordCount} record
        {status.recordCount === 1 ? "" : "s"} processed
        {status.dryRun ? " — writes were captured, not committed." : "."}
      </div>
      {status.errors.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-amber-700">
          {status.errors.map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UsedByChips({ dependents }: { dependents: Array<{ id: string; name: string }> }) {
  const MAX_CHIPS = 3;
  const shown = dependents.slice(0, MAX_CHIPS);
  const more = dependents.length - shown.length;
  return (
    <span className="flex items-center gap-1.5" data-testid="used-by-chips">
      <span className="text-[12px] text-gray-400">Used by</span>
      {shown.map((d) => (
        <Link
          key={d.id}
          href={`/movements/${d.id}`}
          className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-600 hover:bg-gray-200 hover:text-gray-900"
        >
          {d.name}
        </Link>
      ))}
      {more > 0 && (
        <span className="text-[11px] text-gray-400">+{more} more</span>
      )}
    </span>
  );
}

/** The breadcrumb title as an inline-editable field. Looks like the title,
 *  highlights on hover/focus, commits on blur/Enter, reverts on Escape, and
 *  re-syncs when the saved name changes underneath it (e.g. after a save
 *  refetch). Mirrors the shape-graph toolbar's RenameInput. */
function MovementNameInput({
  value,
  onRename,
}: {
  value: string;
  onRename: (to: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Adopt an external change (a refetched name) only when not mid-edit.
  if (draft !== value && document.activeElement?.tagName !== "INPUT") {
    setDraft(value);
  }
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onRename(trimmed);
    else setDraft(value);
  };
  return (
    <input
      aria-label="Movement name"
      value={draft}
      size={Math.max(draft.length, 1)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="-mx-1 max-w-[28ch] rounded-md border border-transparent bg-transparent px-1 text-[15px] font-semibold text-gray-900 hover:border-gray-200 focus:border-gray-400 focus:bg-white focus:outline-none"
    />
  );
}

export function MovementWorkbench(props: MovementWorkbenchProps) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const movementId = props.movementId;

  // Tier 1: the fast skeleton (no instance schemas).
  const { data: catalog, isLoading: catalogLoading } =
    trpc.views.movement.catalog.useQuery(undefined, {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    });

  // Tier 2: the snapshot TYPED FOR THE CURRENT PROGRAM — one call, the compile
  // path's own answer. It supersedes the skeleton wholesale once it lands.
  //
  // This used to be a describeInstance per constructed pair, which could only
  // name an (adapter, credential): it could not say which entry position the
  // construction pinned, nor apply the program's narrowings. So a positioned or
  // narrowed instance was typed against the unpositioned meta node — and for a
  // container-shaped adapter (sheets, airtable) that node deliberately has no
  // leaves, which surfaced as the editor erroring on a correct program's own
  // table while `save` compiled it fine. Two consumers of one instance reading
  // two different schemas from the same source; one routine is the fix.
  const [typedSnapshot, setTypedSnapshot] = useState<CatalogSnapshot | undefined>(undefined);
  const typedForSourceRef = useRef<string | undefined>(undefined);
  const typeForSource = trpc.views.movement.catalogForSource.useMutation();
  const typeForSourceRef = useRef(typeForSource);
  typeForSourceRef.current = typeForSource;

  // Tier 2b: the STARTER's one pair, for /movements/new — there is no program
  // yet, so there is nothing to type against; the question is the connection's
  // own ("what can I do here?"), which is what describeInstance answers.
  const [fetchedSchemas, setFetchedSchemas] = useState<
    Record<string, { adapter: string; credentialName?: string; schema: InstanceSchema | null; notes?: string[] }>
  >({});
  // Pairs that resolved untyped (no credential, broken workspace) — the
  // checker stays silent for them; we just stop waiting on them.
  const [unavailablePairs, setUnavailablePairs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const requestedRef = useRef(new Set<string>());

  // ONE pair, with no program in hand — the /movements/new starter, which needs
  // a schema to pick a sensible first position BEFORE any source exists. The
  // editing path does not come through here: it types the whole program at once
  // (`ensureSchemasFor`), which is the only way to say which position an
  // instance stands at and how the program narrows it.
  const requestPair = useCallback(
    (pair: ConstructionRef) => {
      const key = constructionKey(pair);
      if (requestedRef.current.has(key)) return;
      requestedRef.current.add(key);
      utils.client.views.movement.describeInstance
        .query({
          adapter: pair.adapter,
          ...(pair.credential !== undefined ? { credentialName: pair.credential } : {}),
        })
        .then((result) => {
          setFetchedSchemas((prev) => ({
            ...prev,
            [constructionKey(pair)]: {
              adapter: pair.adapter,
              ...(pair.credential !== undefined ? { credentialName: pair.credential } : {}),
              schema: result.schema,
              ...(result.notes.length > 0 ? { notes: result.notes } : {}),
            },
          }));
          if (!result.schema) {
            setUnavailablePairs((prev) => new Set(prev).add(constructionKey(pair)));
          }
        })
        .catch(() => {
          // Transient failure — allow a retry on the next edit.
          requestedRef.current.delete(key);
          setUnavailablePairs((prev) => new Set(prev).add(constructionKey(pair)));
        });
    },
    [utils],
  );

  // The text the editor currently holds, as a ref — read by callbacks that must
  // act on the LATEST source without re-subscribing on every keystroke.
  const currentSourceRef = useRef<string | null>(null);
  // Forward handle to `ensureSchemasFor`, which is defined below (it depends on
  // the connect path, and the connect path re-types through it).
  const ensureSchemasForRef = useRef<(source: string) => void>(() => {});

  // Force-refresh one instance's schema (skips the requested-once guard and
  // the server TTL cache). Used after a connect action grants new access —
  // the granted entry must show up in completions without a reload.
  const refreshInstance = useCallback(
    (pair: { adapter: string; credential?: string }) => {
      const key = constructionKey(pair);
      utils.client.views.movement.describeInstance
        .query({
          adapter: pair.adapter,
          ...(pair.credential !== undefined ? { credentialName: pair.credential } : {}),
          forceRefresh: true,
        })
        .then((result) => {
          setFetchedSchemas((prev) => ({
            ...prev,
            [key]: {
              adapter: pair.adapter,
              ...(pair.credential !== undefined ? { credential: pair.credential } : {}),
              schema: result.schema,
              ...(result.notes.length > 0 ? { notes: result.notes } : {}),
            },
          }));
          if (result.schema) {
            setUnavailablePairs((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
          }
        })
        .catch(() => {
          /* transient — the next edit re-requests */
        });
    },
    [utils],
  );

  // A "+ connect" completion was picked: dispatch to the app's connect-action
  // handler registry by `kind`. The handler runs the interactive flow (e.g.
  // the Drive Picker), persists the grant, and we refresh the instance so the
  // newly-granted entries surface in suggestions.
  const handleConnectAction = useCallback(
    (action: { kind: string; adapter: string; credential?: string }) => {
      void runConnectAction(action.kind, {
        adapter: action.adapter,
        ...(action.credential !== undefined ? { credential: action.credential } : {}),
        client: utils.client,
        refreshInstance,
      })
        .then(() => {
          // The grant changed what the connection HAS, so the program's schema
          // is now stale. Drop the source key and re-type — otherwise the
          // newly-granted spreadsheet stays invisible until the next keystroke.
          typedForSourceRef.current = undefined;
          const source = currentSourceRef.current;
          if (source !== null) ensureSchemasForRef.current(source);
        })
        .catch((err) => {
          console.error("Connect action failed:", err);
        });
    },
    [utils, refreshInstance],
  );

  // Type the CURRENT program. Keyed on the source itself: the server's answer
  // depends on the whole text (which instances, at which positions, narrowed
  // how), so anything less than the text is a key that can go stale — which is
  // the shape of the last two editor bugs here.
  //
  // The request rides in the BODY (it is a mutation for exactly that reason): a
  // query serializes its input into the URL, and a movement of any size
  // overruns it. Sending something smaller than the program is what made the
  // editor's schema thinner than the compiler's in the first place.
  const ensureSchemasFor = useCallback(
    (source: string) => {
      if (!catalog) return;
      if (typedForSourceRef.current === source) return;
      typedForSourceRef.current = source;
      typeForSourceRef.current
        .mutateAsync({ source })
        .then((result) => {
          // Ignore a response the author has already typed past — responses can
          // land out of order, and an older schema overwriting a newer one puts
          // the checker behind the text.
          if (typedForSourceRef.current !== source) return;
          setTypedSnapshot(result.snapshot);
        })
        .catch(() => {
          // Transient failure — let the next keystroke retry rather than
          // freezing on a stale schema.
          if (typedForSourceRef.current === source) typedForSourceRef.current = undefined;
        });
    },
    [catalog],
  );
  ensureSchemasForRef.current = ensureSchemasFor;

  const snapshot = useMemo<CatalogSnapshot | undefined>(() => {
    if (!catalog) return undefined;
    // The typed snapshot already carries every instance the program constructs,
    // positions and refinements included, so it REPLACES the skeleton rather
    // than being merged over it. The starter's streamed pair only fills in
    // before any program exists to type.
    if (typedSnapshot) return typedSnapshot;
    let merged: CatalogSnapshot = catalog.snapshot;
    for (const entry of Object.values(fetchedSchemas)) {
      merged = mergeInstanceSchema(merged, entry);
    }
    return merged;
  }, [catalog, typedSnapshot, fetchedSchemas]);

  const languageRoute = useMemo<EditorLanguageRoute | undefined>(
    () =>
      props.languageRoute ??
      (catalog ? { kind: "installed", dialect: catalog.installed.dialect } : undefined),
    [props.languageRoute, catalog],
  );

  // The server's lint for a release pin: the movement's own pin when it has a
  // row, else the installed release.
  const checkRemote = useCallback<CheckRemote>(
    async (source, signal) => {
      const { diagnostics } = await utils.client.views.movement.check.mutate(
        { source, ...(movementId !== undefined ? { id: movementId } : {}) },
        { signal },
      );
      return diagnostics;
    },
    [utils, movementId],
  );

  const save = trpc.views.movement.save.useMutation({
    onSuccess: (result) => {
      void utils.views.movement.list.invalidate();
      if (props.movementId) {
        void utils.views.movement.get.invalidate({ id: props.movementId });
      } else if (result.movementId) {
        // First save created the row — move to its page (the source you
        // just wrote rides along as React state until the query loads).
        router.replace(`/movements/${result.movementId}`);
      }
    },
  });
  const remove = trpc.views.movement.delete.useMutation({
    onSuccess: () => {
      void utils.views.movement.list.invalidate();
      router.push("/automations");
    },
  });
  // "Run now" — queue an invocation event on the script's manual-channel
  // listener (`go = manual()` + `listen to go {} fire …`), through normal
  // dispatch (the server rehearses instead when every written instance is
  // dry_run). The server answers with the run's id before the run starts; the
  // status query follows it until it settles.
  const runNow = trpc.views.movement.runNow.useMutation({
    onSuccess: () => {
      // A run consumes its input; clear so the next run starts fresh.
      setRunText("");
      setRunFiles([]);
      setRunPopoverOpen(false);
      if (runFileInputRef.current) runFileInputRef.current.value = "";
    },
  });
  const queuedRunId = runNow.data?.ok ? runNow.data.runId : undefined;
  const runStatus = trpc.views.movement.runStatus.useQuery(
    { runId: queuedRunId ?? "" },
    {
      enabled: queuedRunId !== undefined,
      refetchInterval: (data) =>
        data !== undefined && !("error" in data) && data.status === "running"
          ? 1500
          : false,
    },
  );
  const runInFlight =
    runNow.isLoading ||
    (queuedRunId !== undefined &&
      (runStatus.data === undefined ||
        (!("error" in runStatus.data) && runStatus.data.status === "running")));
  // Optional invocation payload for "Run now" — a manual movement can read
  // the invocation text (`go.\`Text\``) and `#resources`, so the run button expands to let the
  // user type a note and/or attach files. Both stay optional: an empty
  // Run-now fires a bare invocation exactly as before.
  const [runPopoverOpen, setRunPopoverOpen] = useState(false);
  const [runText, setRunText] = useState("");
  const [runFiles, setRunFiles] = useState<PickedFile[]>([]);
  const [runReadingFiles, setRunReadingFiles] = useState(false);
  const runFileInputRef = useRef<HTMLInputElement>(null);

  const onPickRunFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setRunReadingFiles(true);
    try {
      const picked = await Promise.all(Array.from(list).map(readFileAsBase64));
      setRunFiles((prev) => [...prev, ...picked]);
    } finally {
      setRunReadingFiles(false);
    }
  };

  const fireRunNow = () => {
    if (movementId === undefined) return;
    runNow.mutate({
      id: movementId,
      // One id per press: a retried request is the same run, not a second.
      requestId: crypto.randomUUID(),
      text: runText.trim() ? runText.trim() : undefined,
      files:
        runFiles.length > 0
          ? runFiles.map((f) => ({
              filename: f.filename,
              contentType: f.contentType,
              contentBase64: f.contentBase64,
            }))
          : undefined,
    });
  };

  const editorRef = useRef<MovementEditorHandle | null>(null);
  const [diagnostics, setDiagnostics] = useState<MovementDiagnostic[]>([]);

  // Mobile: the side panel (run result / listeners / dependents) is a
  // slide-over drawer, off-screen until toggled, so the editor gets the
  // full width. On desktop it's a static column (md: overrides below).
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  // Cmd/ctrl-click navigation: the editor resolves WHAT was clicked (an
  // imported name / import path); this maps it to a page and opens a new
  // tab. File targets resolve name → id through the movement list.
  const handleNavigate = useCallback(
    (target: DefinitionTarget) => {
      void (async () => {
        const url = await (async (): Promise<string | undefined> => {
          switch (target.kind) {
            case "adapters":
              return "/adapters";
            case "credentials":
              return "/credentials";
            case "plugins":
              return "/plugins";
            case "file": {
              const movements = await utils.views.movement.list.fetch();
              const match = movements.find((m) => m.name === target.name);
              return match ? `/movements/${match.id}` : undefined;
            }
          }
        })();
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      })();
    },
    [utils],
  );

  // Info-severity "nothing fires this movement" hints render as a
  // suggestion card in the Listeners section, not as problems.
  const problems = useMemo(
    () => diagnostics.filter((d) => (d.severity ?? "error") === "error"),
    [diagnostics],
  );
  const listenSuggestions = useMemo(
    () =>
      diagnostics
        .filter((d) => d.code === "MOV_LISTEN_MISSING")
        .map((d) => d.message),
    [diagnostics],
  );

  // The Listeners panel projects the CURRENT text (a listen line is the
  // listener), so the workbench tracks the editor's content as state.
  const [currentSource, setCurrentSource] = useState<string | null>(null);
  const handleEditorChange = useCallback(
    (source: string) => {
      setCurrentSource(source);
      currentSourceRef.current = source;
      ensureSchemasFor(source);
    },
    [ensureSchemasFor],
  );

  // Vim keybindings — off by default, remembered per browser. Read after
  // mount so the server render matches the first client render.
  const [vimEnabled, setVimEnabled] = useState(false);
  const [vimMode, setVimMode] = useState<string | null>(null);
  useEffect(() => {
    setVimEnabled(window.localStorage.getItem(VIM_PREFERENCE_KEY) === "on");
  }, []);
  const toggleVim = useCallback(() => {
    setVimEnabled((enabled) => {
      const next = !enabled;
      window.localStorage.setItem(VIM_PREFERENCE_KEY, next ? "on" : "off");
      return next;
    });
  }, []);

  // Line wrap — off by default, remembered per browser. Read after mount
  // so the server render matches the first client render.
  const [lineWrap, setLineWrap] = useState(false);
  useEffect(() => {
    setLineWrap(window.localStorage.getItem(WRAP_PREFERENCE_KEY) === "on");
  }, []);
  const toggleLineWrap = useCallback(() => {
    setLineWrap((enabled) => {
      const next = !enabled;
      window.localStorage.setItem(WRAP_PREFERENCE_KEY, next ? "on" : "off");
      return next;
    });
  }, []);

  // Code, story, or activity — the same saved automation, read three ways.
  // Code is the default because this pane is where you edit; story and
  // activity both need a SAVED movement, so an unsaved page never offers them.
  //
  // Which reading you are on lives in the URL, not in component state: it is
  // part of WHERE YOU ARE. A refresh keeps it, and "look at what this thing
  // does" becomes a link you can send, distinct from "look at this script".
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const viewParam = searchParams.get(VIEW_PARAM);
  const view: WorkbenchView =
    movementId === undefined
      ? "code"
      : viewParam === STORY_VIEW
        ? STORY_VIEW
        : viewParam === ACTIVITY_VIEW
          ? ACTIVITY_VIEW
          : "code";
  const setView = useCallback(
    (wanted: WorkbenchView) => {
      const next = new URLSearchParams(searchParams.toString());
      if (wanted === "code") next.delete(VIEW_PARAM);
      else next.set(VIEW_PARAM, wanted);
      // The run filters belong to the activity reading only — leaving it drops
      // them rather than parking them in a URL that no longer honours them.
      if (wanted !== ACTIVITY_VIEW) {
        next.delete(LANE_PARAM);
        next.delete(STATUS_PARAM);
      }
      const query = next.toString();
      // Replaced, not pushed: switching reading is not a place you want the
      // back button to walk through one step at a time.
      router.replace(query === "" ? pathname : `${pathname}?${query}`, {
        scroll: false,
      });
    },
    [router, pathname, searchParams],
  );

  // A listener card opens the activity reading filtered to its lane — the
  // same URL a link would carry, applied in place (the panel is already on
  // the movement's page, so there is nowhere to navigate to).
  const openActivityForLane = useCallback(
    (lane: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set(VIEW_PARAM, ACTIVITY_VIEW);
      next.set(LANE_PARAM, lane);
      next.delete(STATUS_PARAM);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      setMobilePanelOpen(false);
    },
    [router, pathname, searchParams],
  );

  // The starter script for /movements/new constructs the workspace's first
  // credentialed source, so it needs that one pair's schema to pick a
  // sensible position — request just that pair up front.
  const starterPair = useMemo<ConstructionRef | undefined>(() => {
    if (!catalog) return undefined;
    const entry = Object.entries(catalog.snapshot.credentials)[0];
    if (!entry) return undefined;
    const [credentialName, cred] = entry;
    const adapter = "adapters" in cred ? cred.adapters[0] : cred.adapter;
    if (adapter === undefined) return undefined;
    return { adapter, credential: credentialName };
  }, [catalog]);

  useEffect(() => {
    if (!catalog) return;
    if (props.initialSource !== undefined) {
      ensureSchemasFor(props.initialSource);
    } else if (starterPair && props.starter !== "library") {
      requestPair(starterPair);
    }
  }, [catalog, props.initialSource, props.starter, starterPair, ensureSchemasFor, requestPair]);

  const initialSource = useMemo(() => {
    if (props.initialSource !== undefined) return props.initialSource;
    if (!snapshot) return undefined; // skeleton still loading
    // The library starter is self-contained (shapes + movements, no
    // constructions), so it never waits on instance schemas.
    if (props.starter === "library") return LIBRARY_STARTER_SOURCE;
    if (!starterPair) return FALLBACK_SOURCE; // no credentials yet
    const key = constructionKey(starterPair);
    if (fetchedSchemas[key]) return starterSource(snapshot);
    if (unavailablePairs.has(key)) return FALLBACK_SOURCE;
    return undefined; // the starter pair's schema is still streaming in
  }, [props.initialSource, props.starter, snapshot, starterPair, fetchedSchemas, unavailablePairs]);

  // Seed the tracked text once the editor's seed resolves; afterwards the
  // editor's onChange keeps it current.
  useEffect(() => {
    if (initialSource !== undefined) {
      setCurrentSource((prev) => (prev === null ? initialSource : prev));
      if (currentSourceRef.current === null) currentSourceRef.current = initialSource;
    }
  }, [initialSource]);

  // Dirty = the editor holds edits not yet reflected in the saved/loaded
  // source. Held in a ref so the subscription callback below reads the
  // live value, never a stale closure capture.
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current =
      currentSource !== null &&
      initialSource !== undefined &&
      currentSource !== initialSource;
  }, [currentSource, initialSource]);

  // The version the editor loaded — base for the save-time concurrency
  // guard. It advances automatically: a successful save / a reload both
  // invalidate the `get` query, the page refetches, and this prop updates.
  const baseUpdatedAt = useMemo(
    () =>
      props.initialUpdatedAt
        ? new Date(props.initialUpdatedAt).toISOString()
        : undefined,
    [props.initialUpdatedAt],
  );

  // Pull the stored version into the editor (fetch → setSource — the
  // editor only seeds its initialValue on mount, so a prop change alone
  // wouldn't update the visible text).
  const reloadFromServer = useCallback(async () => {
    if (!movementId) return;
    const fresh = await utils.views.movement.get.fetch({ id: movementId });
    if (!fresh) return;
    editorRef.current?.setSource(fresh.source);
    setCurrentSource(fresh.source);
    setStaleByAgent(false);
    void utils.views.movement.list.invalidate();
  }, [movementId, utils]);

  // THIS movement was edited elsewhere (another tab, or an agent over MCP). When the
  // editor is clean, reload silently. When the user has unsaved edits,
  // DON'T clobber them — raise a banner and let them choose (the save-time
  // guard is the backstop if they keep editing and save).
  const [staleByAgent, setStaleByAgent] = useState(false);
  trpc.views.knowledge.ontology.onResourceChange.useSubscription(
    { kinds: ["movement"] },
    {
      onData: (evt) => {
        // Our own UI save echoes back — already shown. But agent saves run
        // inside our request origin, so don't dedup those by originId: an
        // agent filling this movement in must always be reflected (the
        // progressive-authoring "watch it come together" path).
        if (evt.source !== "agent" && evt.originId === TAB_ORIGIN_ID) return;
        if (!movementId) return;
        if (evt.resourceId && evt.resourceId !== movementId) return;
        if (dirtyRef.current) {
          setStaleByAgent(true);
          return;
        }
        void reloadFromServer();
      },
    },
  );

  const result = save.data;
  const validityStatus =
    result && "validity" in result && result.validity !== undefined
      ? result.validity.status
      : props.initialValidityStatus ?? null;

  // A save the server held back because the stored version moved on.
  const saveConflict =
    result && result.ok === false && "conflict" in result && result.conflict
      ? result.conflict
      : null;

  // Re-save the editor's current text WITHOUT the base version — a
  // deliberate overwrite of whatever's stored now.
  const forceOverwrite = useCallback(() => {
    const source = editorRef.current?.getSource();
    if (source) {
      save.mutate({ source, ...(movementId ? { id: movementId } : {}) });
    }
  }, [movementId, save]);

  // A save the server withheld because it has problems (or couldn't be
  // verified against a connected system). "Save anyway" is the explicit
  // consent — the broken version genuinely replaces what runs.
  const saveAnyway = useCallback(() => {
    const source = editorRef.current?.getSource();
    if (!source) return;
    save.mutate({
      source,
      acknowledgeErrors: true,
      ...(movementId ? { id: movementId } : {}),
      ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
    });
  }, [movementId, save, baseUpdatedAt]);

  // The plain "Save" action — the editor's current text, guarded by the
  // load version (the same concurrency base the Save button uses). Shared by
  // the button and the cmd/ctrl-S shortcut.
  const handleSave = useCallback(() => {
    if (save.isLoading || catalogLoading) return;
    const source = editorRef.current?.getSource();
    if (!source) return;
    save.mutate({
      source,
      ...(movementId ? { id: movementId } : {}),
      ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
    });
  }, [save, catalogLoading, movementId, baseUpdatedAt]);

  // Rename from the breadcrumb. A movement's name is also the identity other
  // scripts import it by, so when importers exist we warn before proceeding
  // (warn-and-allow — the user stays in control). The new name rides a normal
  // save, so it persists durably and the current text saves alongside it.
  const handleRename = useCallback(
    (newName: string) => {
      if (!movementId) return;
      const source = editorRef.current?.getSource();
      if (!source) return;
      const deps = props.dependents ?? [];
      if (deps.length > 0) {
        const names = deps.map((d) => d.name).join(", ");
        const verb = deps.length === 1 ? "movement imports" : "movements import";
        const them = deps.length === 1 ? "it" : "them";
        const theirImports = deps.length === 1 ? "its import" : "their imports";
        if (
          !window.confirm(
            `${deps.length} ${verb} "${props.movementName}" by name (${names}). ` +
              `Renaming to "${newName}" will break ${them} until you update ${theirImports}. Rename anyway?`,
          )
        ) {
          return;
        }
      }
      save.mutate({
        source,
        id: movementId,
        name: newName,
        ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
      });
    },
    [movementId, props.movementName, props.dependents, save, baseUpdatedAt],
  );

  // cmd/ctrl-S saves the movement instead of triggering the browser's
  // save-page dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  // Trigger-side listener details (channel, inbound address): the latest
  // clean save wins, falling back to what the page loaded with.
  const serverListeners = useMemo<ListenerSummary[]>(() => {
    const loaded = props.initialListeners ?? [];
    if (!result?.ok) return loaded;
    // A save's provisioned listeners are the fresher truth, but they don't
    // carry the trigger's lane name — take that from what the page loaded,
    // matched by trigger id (a listener that survives a save keeps its id).
    const laneById = new Map(loaded.map((l) => [l.triggerId, l.name]));
    return result.listeners.map((l) => ({
      ...l,
      name: laneById.get(l.triggerId) ?? null,
    }));
  }, [result, props.initialListeners]);

  // "Run now" availability mirrors the manual-channel listener: the latest
  // shipped save's listeners win, falling back to the page load. A held-back
  // save keeps the last shipped listener runnable.
  const runnable = result?.ok
    ? result.listeners.some((l) => l.kind === "manual")
    : props.initialRunnable ?? false;

  // After a shipped save, the server re-checked every script importing this
  // file against the new text (report-only — their stored validity is
  // assessed by their own saves and runs). Split the verdicts for the card.
  const dependentChecks = useMemo(
    () => (result?.ok ? result.dependentChecks ?? [] : []),
    [result],
  );
  const dependentsBroken = dependentChecks.filter((c) => !c.ok);
  const dependentsClean = dependentChecks.length - dependentsBroken.length;

  // Pause/resume/add all EDIT THE SCRIPT — the listen line is the
  // listener, so the affordances rewrite it (and save, for pause/resume).
  const applyScriptEdit = useCallback(
    (next: string, options: { save: boolean }) => {
      editorRef.current?.setSource(next);
      setCurrentSource(next);
      ensureSchemasFor(next);
      if (options.save) {
        save.mutate({
          source: next,
          ...(movementId ? { id: movementId } : {}),
          ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
        });
      }
    },
    [ensureSchemasFor, movementId, save, baseUpdatedAt],
  );

  const pauseListener = useCallback(
    (span: { startLine: number; endLine: number }) => {
      const source = editorRef.current?.getSource();
      if (source === undefined) return;
      applyScriptEdit(commentListenLines(source, span), { save: true });
    },
    [applyScriptEdit],
  );

  const resumeListener = useCallback(
    (span: { startLine: number; endLine: number }) => {
      const source = editorRef.current?.getSource();
      if (source === undefined) return;
      applyScriptEdit(uncommentListenLines(source, span), { save: true });
    },
    [applyScriptEdit],
  );

  const addListener = useCallback(
    (line: string) => {
      const source = editorRef.current?.getSource() ?? "";
      const next = `${source.replace(/\n*$/, "\n")}\n${line}\n`;
      applyScriptEdit(next, { save: false });
    },
    [applyScriptEdit],
  );

  const reveal = (span: { start: { line: number; col: number } }) => {
    const source = editorRef.current?.getSource() ?? "";
    const from = offsetOf(source, span.start);
    editorRef.current?.revealRange(from, from);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-6">
        <div className="flex items-baseline gap-2.5">
          <Link href="/automations" className="text-[12px] text-gray-400 hover:text-gray-600">
            Automations
          </Link>
          <span className="text-[12px] text-gray-300">/</span>
          {props.movementId ? (
            <MovementNameInput value={props.movementName ?? ""} onRename={handleRename} />
          ) : (
            <h1 className="text-[15px] font-semibold text-gray-900">
              {props.movementName ?? "New movement"}
            </h1>
          )}
          {validityStatus && <ValidityBadge validityStatus={validityStatus} />}
          {(props.dependents?.length ?? 0) > 0 && (
            <UsedByChips dependents={props.dependents ?? []} />
          )}
          {!props.movementId && (
            <span className="hidden text-[12px] text-gray-400 md:inline">
              {props.starter === "library"
                ? "shared movements and shapes other scripts import"
                : "a script that moves data when something happens"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {movementId !== undefined && (
            <div className="mr-1 flex items-center gap-1 rounded-full border border-gray-200 p-0.5">
              {(
                [
                  ["Code", "code", "See the script"],
                  [
                    "Story",
                    STORY_VIEW,
                    "See what this automation does, in plain language",
                  ],
                  [
                    "Activity",
                    ACTIVITY_VIEW,
                    "See every run of this automation, across its triggers",
                  ],
                ] as const
              ).map(([label, target, title]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setView(target)}
                  aria-pressed={view === target}
                  title={title}
                  className={`rounded-full px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
                    view === target
                      ? "bg-primary-50 text-primary-700"
                      : "text-gray-400 hover:text-gray-600"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setMobilePanelOpen(true)}
            title="Show details"
            aria-label="Show details panel"
            className="flex items-center rounded-lg p-1.5 text-gray-400 hover:bg-gray-50 hover:text-gray-700 md:hidden"
          >
            <PanelRight size={15} />
          </button>
          <Link
            href="/library?book=movements"
            target="_blank"
            title="Open the movements handbook"
            aria-label="Open the movements handbook"
            className="flex items-center rounded-lg p-1.5 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
          >
            <HelpCircle size={15} />
          </Link>
          {movementId !== undefined && (
            <button
              type="button"
              disabled={remove.isLoading}
              onClick={() => {
                if (
                  window.confirm(
                    "Delete this movement? It stops running and its script is removed.",
                  )
                ) {
                  remove.mutate({ id: movementId });
                }
              }}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700"
            >
              <Trash2 size={13} />
              Delete
            </button>
          )}
          {movementId !== undefined && runnable && (
            <div className="relative">
              <button
                type="button"
                disabled={runInFlight}
                onClick={() => setRunPopoverOpen((open) => !open)}
                aria-expanded={runPopoverOpen}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-[12px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                data-testid="run-now-button"
              >
                {runInFlight ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Play size={13} />
                )}
                Run now
              </button>

              {runPopoverOpen && (
                <>
                  {/* Click-away backdrop. */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setRunPopoverOpen(false)}
                    aria-hidden="true"
                  />
                  <div
                    className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-gray-200 bg-white p-3.5 shadow-lg"
                    data-testid="run-now-popover"
                  >
                    <p className="mb-2 text-[12px] leading-relaxed text-gray-500">
                      Run this movement now. Optionally give it some input — a
                      note and/or files the movement can read.
                    </p>

                    <textarea
                      value={runText}
                      onChange={(e) => setRunText(e.target.value)}
                      placeholder="Add a note (optional)…"
                      rows={3}
                      className="w-full resize-y rounded-md border border-gray-200 px-2.5 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                      data-testid="run-now-text"
                    />

                    {runFiles.length > 0 && (
                      <ul
                        className="mt-2 space-y-1"
                        data-testid="run-now-file-list"
                      >
                        {runFiles.map((f, i) => (
                          <li
                            key={`${f.filename}-${i}`}
                            className="flex items-center justify-between rounded-md border border-gray-100 bg-gray-50/60 px-2.5 py-1.5 text-[12px] text-gray-700"
                          >
                            <span className="min-w-0 truncate">
                              {f.filename}{" "}
                              <span className="text-gray-400">
                                ({formatFileSize(f.size)})
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setRunFiles((prev) =>
                                  prev.filter((_, idx) => idx !== i),
                                )
                              }
                              className="ml-2 shrink-0 text-gray-400 hover:text-gray-700"
                              aria-label={`Remove ${f.filename}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <input
                      ref={runFileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => void onPickRunFiles(e.target.files)}
                      data-testid="run-now-file-input"
                    />

                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => runFileInputRef.current?.click()}
                        disabled={runReadingFiles || runInFlight}
                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1.5 text-[12px] font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                        data-testid="run-now-attach"
                      >
                        <Paperclip className="h-3 w-3" />
                        {runReadingFiles ? "Reading…" : "Attach files"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              "Run this movement now? It runs against live systems.",
                            )
                          ) {
                            fireRunNow();
                          }
                        }}
                        disabled={runReadingFiles || runInFlight}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-gray-700 disabled:opacity-50"
                        data-testid="run-now-confirm"
                      >
                        {runInFlight ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Play className="h-3 w-3" />
                        )}
                        Run now
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          <button
            type="button"
            disabled={save.isLoading || catalogLoading}
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {save.isLoading && <Loader2 size={13} className="animate-spin" />}
            Save
            <kbd className="ml-1 text-[10px] tracking-wide text-white/50">⌘S</kbd>
          </button>
        </div>
      </div>

      {/* Concurrency banners. The save-conflict (reactive) wins over the
          stale-by-agent heads-up (proactive) when both could apply. */}
      {saveConflict ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-900">
          <span>
            This automation changed since you opened it — your save was held
            back so it wouldn’t overwrite the newer version.
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void reloadFromServer()}
              className="rounded-md border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-900 hover:bg-amber-100"
            >
              Load the current version
            </button>
            <button
              type="button"
              onClick={forceOverwrite}
              className="rounded-md px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-100"
            >
              Overwrite with mine
            </button>
          </div>
        </div>
      ) : staleByAgent ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-900">
          <span>
            This automation changed elsewhere while you were editing it.
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void reloadFromServer()}
              className="rounded-md border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-900 hover:bg-amber-100"
            >
              Load its version (discards your edits)
            </button>
            <button
              type="button"
              onClick={() => setStaleByAgent(false)}
              className="rounded-md px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-100"
            >
              Keep editing
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 border-t border-gray-100">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The editor stays MOUNTED behind the story — unmounting CodeMirror
              would throw away an unsaved draft, and a read-only view must
              never cost you your edits. */}
          {view === STORY_VIEW && movementId !== undefined && (
            <div className="min-h-0 flex-1">
              <MovementStory
                movementId={movementId}
                unsavedEdits={
                  currentSource !== null &&
                  initialSource !== undefined &&
                  currentSource !== initialSource
                }
              />
            </div>
          )}
          {view === ACTIVITY_VIEW && movementId !== undefined && (
            <div className="min-h-0 flex-1">
              <MovementActivity movementId={movementId} />
            </div>
          )}
          <div className={view === "code" ? "min-h-0 flex-1" : "hidden"}>
            {!snapshot || !languageRoute || initialSource === undefined ? (
              <div className="flex h-full items-center justify-center text-[13px] text-gray-400">
                <Loader2 size={15} className="mr-2 animate-spin" />
                Loading your workspace catalog…
              </div>
            ) : (
              <MovementEditor
                ref={editorRef}
                initialValue={initialSource}
                snapshot={snapshot}
                {...(props.languageVersion !== undefined
                  ? { languageVersion: props.languageVersion }
                  : {})}
                languageRoute={languageRoute}
                checkRemote={checkRemote}
                onChange={handleEditorChange}
                onDiagnostics={setDiagnostics}
                vimEnabled={vimEnabled}
                onVimModeChange={setVimMode}
                lineWrap={lineWrap}
                onNavigate={handleNavigate}
                onConnectAction={handleConnectAction}
              />
            )}
          </div>

          {/* Status strip: vim mode on the left, the Wrap/Vim toggles on the
              right. Both are editor settings, so they go away with it. */}
          <div
            className={`h-9 shrink-0 items-center justify-between border-t border-gray-100 px-6 ${
              view === "code" ? "flex" : "hidden"
            }`}
          >
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-gray-400">
              {vimEnabled ? vimMode ?? "normal" : ""}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleLineWrap}
                aria-pressed={lineWrap}
                title={lineWrap ? "Turn off line wrap" : "Turn on line wrap"}
                className={`rounded-full border px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
                  lineWrap
                    ? "border-primary-200 bg-primary-50 text-primary-700"
                    : "border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600"
                }`}
              >
                Wrap
              </button>
              <button
                type="button"
                onClick={toggleVim}
                aria-pressed={vimEnabled}
                title={
                  vimEnabled
                    ? "Turn off Vim keybindings"
                    : "Turn on Vim keybindings"
                }
                className={`rounded-full border px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
                  vimEnabled
                    ? "border-primary-200 bg-primary-50 text-primary-700"
                    : "border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600"
                }`}
              >
                Vim
              </button>
            </div>
          </div>
        </div>

        {/* Mobile backdrop — tap to dismiss the drawer. */}
        {mobilePanelOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/20 md:hidden"
            onClick={() => setMobilePanelOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Details panel. Desktop: a static 360px column. Mobile: a
            slide-over drawer (fixed, off-screen until toggled) so the
            editor keeps the full width. */}
        <aside
          className={`z-40 flex w-[85vw] max-w-sm flex-col gap-7 overflow-y-auto border-l border-gray-100 bg-white px-6 py-6 transition-transform md:static md:z-auto md:w-[360px] md:max-w-none md:translate-x-0 md:transition-none ${
            mobilePanelOpen
              ? "fixed inset-y-0 right-0 translate-x-0 shadow-xl md:shadow-none"
              : "fixed inset-y-0 right-0 translate-x-full md:shadow-none"
          }`}
        >
          {/* Mobile-only close affordance. */}
          <button
            type="button"
            onClick={() => setMobilePanelOpen(false)}
            aria-label="Close details panel"
            className="-mt-2 -mr-2 self-end rounded-lg p-1.5 text-gray-400 hover:bg-gray-50 hover:text-gray-700 md:hidden"
          >
            <X size={16} />
          </button>
          {/* Run-now result */}
          {runNow.error && (
            <div className="rounded-xl border border-red-100 bg-red-50/70 px-4 py-3.5">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-red-800">
                <AlertCircle size={15} />
                The run failed
              </div>
              <div className="mt-2 text-[12px] leading-relaxed text-red-700">
                {runNow.error.message}
              </div>
            </div>
          )}
          {runNow.data &&
            (runNow.data.ok ? (
              <RunNowOutcome
                movementName={runNow.data.movementName}
                status={runStatus.data}
              />
            ) : (
              <div className="rounded-xl border border-red-100 bg-red-50/70 px-4 py-3.5">
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-red-800">
                  <AlertCircle size={15} />
                  Couldn&apos;t run this movement
                </div>
                <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-red-700">
                  {runNow.data.errors.map((error, i) => (
                    <li key={i}>{error}</li>
                  ))}
                </ul>
              </div>
            ))}

          {/* Save result */}
          {result &&
            (result.ok ? (
              <div className="rounded-xl border border-green-100 bg-green-50/70 px-4 py-3.5">
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-green-800">
                  <CheckCircle2 size={15} />
                  Movement &lsquo;{result.movementName}&rsquo; is live
                </div>
                <div className="mt-2 text-[12px] leading-relaxed text-green-700">
                  {result.listeners.length === 0
                    ? "No listeners — nothing runs this file on events."
                    : result.listeners.length === 1
                      ? "Its listener is live — details under Listeners."
                      : `Its ${result.listeners.length} listeners are live — details under Listeners.`}
                </div>
                {dependentChecks.length > 0 && (
                  <div
                    className="mt-2.5 border-t border-green-100 pt-2.5 text-[12px] leading-relaxed"
                    data-testid="dependent-checks"
                  >
                    {dependentsBroken.length === 0 ? (
                      <span className="text-green-700">
                        {dependentsClean === 1
                          ? "The script that imports this file still checks clean."
                          : `All ${dependentsClean} scripts that import this file still check clean.`}
                      </span>
                    ) : (
                      <div className="text-amber-700">
                        {dependentsClean > 0 && (
                          <span>
                            {dependentsClean} script
                            {dependentsClean === 1 ? "" : "s"} that import this
                            file still {dependentsClean === 1 ? "checks" : "check"}{" "}
                            clean;{" "}
                          </span>
                        )}
                        <span>
                          {dependentsBroken.length === 1
                            ? "1 now has problems"
                            : `${dependentsBroken.length} now have problems`}{" "}
                          with this change:
                        </span>
                        <span className="mt-1.5 flex flex-wrap gap-1.5">
                          {dependentsBroken.map((d) => (
                            <Link
                              key={d.id}
                              href={`/movements/${d.id}`}
                              className="rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[11px] text-amber-800 hover:bg-amber-200"
                            >
                              {d.name}
                            </Link>
                          ))}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-3.5">
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-amber-800">
                  <AlertCircle size={15} />
                  {"needsConfirmation" in result && result.needsConfirmation
                    ? "This version has problems — it won't work as written"
                    : "Couldn't save this movement"}
                </div>
                <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-amber-700">
                  {(result.errors ?? []).map((error, i) => (
                    <li key={`e${i}`}>{error}</li>
                  ))}
                  {(result.diagnostics ?? []).map((d, i) => (
                    <li key={`d${i}`}>
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => reveal(d.span)}
                      >
                        <span className="font-mono text-[11px]">
                          {d.span.start.line}:{d.span.start.col}
                        </span>{" "}
                        {d.message}
                      </button>
                    </li>
                  ))}
                </ul>
                {"needsConfirmation" in result && result.needsConfirmation && (
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={saveAnyway}
                      disabled={save.isLoading}
                      className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
                    >
                      Save anyway
                    </button>
                    <span className="text-[11.5px] text-amber-700/80">
                      This replaces the running version — it will likely fail
                      until the problems are fixed.
                    </span>
                  </div>
                )}
              </div>
            ))}

          {/* Listeners — the file's listen lines, with pause/resume. */}
          <ListenersPanel
            source={currentSource}
            serverListeners={serverListeners}
            suggestionMessages={listenSuggestions}
            saving={save.isLoading}
            onPause={pauseListener}
            onResume={resumeListener}
            onAddListener={addListener}
            onOpenActivity={openActivityForLane}
          />

          {/* Live diagnostics */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">
                Problems
              </h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  problems.length === 0
                    ? "bg-green-50 text-green-700"
                    : "bg-red-50 text-red-700"
                }`}
              >
                {problems.length}
              </span>
            </div>
            {problems.length === 0 ? (
              <div className="flex items-center gap-2 text-[12.5px] text-gray-400">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                No problems — the script checks out.
              </div>
            ) : (
              <ul className="-mx-3 space-y-0.5">
                {problems.map((d, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => editorRef.current?.revealRange(d.from, d.to)}
                      className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-gray-50"
                    >
                      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                      <span className="min-w-0">
                        <span className="block text-[12.5px] leading-relaxed text-gray-700">
                          {d.message}
                        </span>
                        <span className="mt-1 block font-mono text-[11px] text-gray-400">
                          Line {d.span.start.line}, column {d.span.start.col}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {props.languageVersion !== undefined && (
            <LanguageVersionNotice
              languageVersion={props.languageVersion}
              upgradeDiagnostics={props.upgradeDiagnostics ?? null}
            />
          )}

          {/* How saving works */}
          <p className="mt-auto text-[12px] leading-relaxed text-gray-400">
            Saving always keeps your script. When it has no problems, the
            movement also goes live; otherwise it stays a draft and the last
            live version keeps running.
          </p>
        </aside>
      </div>
    </div>
  );
}
