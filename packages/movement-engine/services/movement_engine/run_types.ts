// What a run takes and what it hands back: the input a shell gives the engine
// (the contract's run data plus the host), the result of one segment (its
// writes, its trace, whether it parked or was cancelled), and the trace's
// entries. Both engines answer in these shapes, so they live apart from either
// one.

import type { ResumeInput, RunInput, WriteRecord as RecordedWrite } from 'engine-contracts';
import type { ExtractSiteSummary } from './provenance';
import type { EngineHost } from './host';

/** A run's input: the data is the contract's (`engine-contracts`), and the
 *  host is everything the run reaches outside its program (`host.ts`). */
export interface RunMovementInput extends RunInput {
  host: EngineHost;
}

/** Why a run paused: the limit it met, with what it had spent against it and
 *  the cap (in microdollars). Today the only limit is the cost cap. */
export interface RunLimitPause {
  limit: 'cost';
  capMicrodollars: number;
  spentMicrodollars: number;
}

/**
 * The durable-park seam — injected so the pure interpreter never touches the
 * DB directly (mirrors `resolveAdapter`/`writeSink`). The recorder-backed
 * production sink lives in `runMovementFiring`.
 */
export interface ParkSink {
  /**
   * Record (or top up) a JOIN frame's pending-count (§5.4, 3.2b) — the number of
   * its child branches that PARKED. `interpretParallel` / `interpretBlock` call
   * this when they re-throw `RunParked` after firing all N children: the frame
   * (a parallel / fan-out) is itself pending until every parked child resolves.
   * Idempotent on (run_id, frame_address) — a re-run that re-reaches the same
   * frame OVERWRITES the count to the same value (the frontier is deterministic
   * under P11), so a crashed-then-re-run firing never double-counts.
   */
  recordJoin(input: { frameAddress: string; parkedChildren: number }): Promise<void>;
  /**
   * Record a TIMER park (`sleep` statement): UPSERTs a `parked_run` row with
   * `park_reason='timer'` and `wake_at` set to the absolute resume instant, then
   * marks the run `parked`. No `interaction_request` is created and no token is
   * minted — the wake driver resumes without a human answer. Idempotent on
   * `(run_id, address)`.
   */
  commitTimerPark(input: {
    address: string;
    state: unknown;
    /** When to wake, as an ISO 8601 instant. */
    wakeAt: string;
  }): Promise<void>;
  /**
   * Record an AWAIT park (`await x-[:E]->` untilNonEmpty, asks-as-adapter §A):
   * a `parked_run` row with `park_reason='await'` + the serialized scope, then
   * the correlation from `(adapterType, correlationKey)` to this park. Unlike
   * `commitPark` there is NO `interaction_request` and NO token — a wake on the
   * key drives resume, which RE-ENTERS at the await (`reenter`) and re-checks
   * live. Idempotent on `(run_id, address)`. The engine re-checks once after
   * this returns and asks `park.wake` when the await already resolved.
   */
  commitAwaitPark(input: {
    address: string;
    state: unknown;
    /** Whose key it is: the awaitable adapter's type, or the reserved callback
     *  identity. */
    adapterType: string;
    correlationKey: string;
  }): Promise<void>;
  /** Resume-unwind join decrement (§6.1). Returns { closed } — true for the unique
   *  branch that closes the frame (runs the post-join continuation). Crash-safe closer
   *  identity via join_pending.closed_by_address. Per-leaf EXACTLY-ONCE via the
   *  `branchAddress` decrement claim (join_branch_export.decremented, §7): a branch
   *  re-scanned after a crash between its decrement and its leaf delete does NOT
   *  decrement the join a second time. */
  decrementJoin(input: {
    frameAddress: string;
    branchAddress: string;
    leafAddress: string;
  }): Promise<{ closed: boolean }>;
  /** Persist a completed branch's exports at its join frame (§12.1), before decrement. */
  persistBranchExport(input: {
    frameAddress: string;
    branchAddress: string;
    branchIndex: number;
    exports: unknown;
  }): Promise<void>;
  /** Collect all branches' persisted exports for a frame, ordered by branchIndex (§12.4). */
  collectBranchExports(input: { frameAddress: string }): Promise<
    Array<{ branchAddress: string; branchIndex: number; exports: unknown }>
  >;
  /**
   * Cancel every park under the given subtree prefixes (asks-as-adapter chunk C
   * — the race cascade, P17). For each parked leaf whose address is at-or-below
   * a prefix: deliver the one cancellation signal (drop its awaitable-adapter
   * correlation so a late resolution lands as data, F7), delete its `parked_run`
   * row, and clear any `join_pending` frame within the cancelled subtree (S19 —
   * no dangling bookkeeping). Idempotent (a re-scan finds the rows gone).
   */
  cancelSubtrees(input: { subtreeAddresses: string[]; excludeLeaf?: string }): Promise<void>;
  /**
   * Record an ENGINE-INITIATED suspension (`suspendFlow`): a `parked_run` row
   * whose state says `suspended` — resume re-enters AT the statement
   * (`reenter`) and replays the calls it had finished. No correlation and no
   * wake time: what resumes it is resuming the run (`limit_pause.ts`).
   * Optional: a sink without it (a rehearsal) cannot suspend, so a run that
   * meets its cost cap there fails on the cap instead.
   */
  commitSuspension?(input: { address: string; state: unknown }): Promise<void>;
  /**
   * The run has just met a limit and is PAUSING: mark the run paused (with
   * the limit, what it spent and the cap — what its status shows) and say so
   * (the `Run Paused` system event). Called once, by the first flow to meet
   * the limit, before any flow's `commitSuspension`.
   */
  commitLimitPause?(pause: RunLimitPause): Promise<void>;
}

/**
 * The cooperative cancel gate (runs-and-cancel spec §cancel). A user-requested
 * cancel stops the run at the next STATEMENT boundary, and — because one
 * statement can be minutes of work — at the boundaries INSIDE a statement too:
 * every LLM call and every plugin invocation of an extraction
 * (`extraction.ts`). Cancel means "stop doing things", not just "stop spending".
 *
 * Every one of those is the same debounced async read, which is the point: a
 * gate whose in-statement reading was a cached value could only ever repeat what
 * the statement boundary already knew, and a statement that is the movement's
 * last one has no next boundary to learn from. The recorder-backed production
 * gate is `makeDbCancelGate` (`cancel_gate.ts`), which debounces to one DB read
 * per few seconds across all of them. Fail-open: a read fault reads as
 * not-cancelled (a DB blip must never stop a healthy run). Absent ⇒ the run is
 * never cancel-gated (dry runs, bare `runMovement`).
 */
export interface CancelGate {
  /** Debounced async check — every boundary's gate, statement and in-statement
   *  alike. Latches once true, and one read serves them all. */
  cancelled(): Promise<boolean>;
  /** The same check with the debounce skipped, for the run's FINAL boundary —
   *  where a stale "no" is not a few seconds' latency but a cancel discarded
   *  forever, because there is no later boundary to notice it at. */
  cancelledNow(): Promise<boolean>;
}


/**
 * One applied (or dry-run-captured) write, in program order — the
 * firing-record entry: the contract's write record. The engine holds it as
 * the `WriteRecord` a write handle binds to (see `expression.ts`), so the
 * binding value and the firing entry are one object while the run lasts;
 * the result hands back the contract's record, without the handle's `old`.
 */
export type MovementWriteRecord = RecordedWrite;

export interface MovementRunResult {
  movementName: string;
  /** What this SEGMENT spent on priced work (model calls, paid services,
   *  priced plugins), in microdollars — absent when it spent nothing. A
   *  resumed segment counts only its own spend here; the run's figure is
   *  `runSpentMicrodollars`. */
  spentMicrodollars?: number;
  /** What the whole RUN has spent, every segment up to and including this
   *  one — what the cost cap reads. Present whenever the run has spent
   *  anything, even if this segment did not. */
  runSpentMicrodollars?: number;
  /** This segment's spend by where it went (`costSourceKey`: `model:<model>`,
   *  `service:<vendor.product>`, `plugin:<name>`, …) — absent when it spent
   *  nothing. Segments add up to the run's breakdown. */
  spentBySource?: Record<string, number>;
  /** Writes in program order — the firing record's raw material. */
  writes: MovementWriteRecord[];
  /** The extraction call sites the writes' provenance references,
   *  interned by site id (refs in `provenance`, detail here, once). */
  extractionSites: Record<string, ExtractSiteSummary>;
  /** Decision-point trace, in program order — why the run did (or did
   *  not do) what it did. See `MovementTraceEntry`. */
  trace: MovementTraceEntry[];
  /**
   * The run PARKED at an `ask` (async user interaction) rather than running
   * to completion — its parked frontier + the `interaction_request`(s) are
   * persisted, the `trigger_run` is `parked`, and the firing caller must NOT
   * finalise it as a terminal run (it resumes when the answer arrives). Absent
   * / false ⇒ an ordinary completed run.
   */
  parked?: boolean;
  /**
   * The lexical address the run (re-)parked at — present iff `parked`. The
   * await-resume driver (`await_resume.ts`) compares it to the leaf it re-entered:
   * a DEEPER/different address means the leaf's await RESOLVED and the resumed
   * body parked forward (drop the now-stale leaf); the SAME address means the
   * await RE-ARMED without resolving (a WHERE-narrowed await whose live landings
   * still don't match) — its park rows were just re-committed, so leave them be.
   * Without this the driver can't distinguish the two and destroys a re-armed
   * park, stranding the run parked forever.
   */
  parkedAddress?: string;
  /**
   * The run was CANCELLED by a user request (runs-and-cancel spec §cancel): the
   * interpreter hit the cancel gate at a statement / LLM-call boundary and threw
   * `RunCancelledSignal`. Exactly parallel to `parked` — the firing caller must
   * NOT finalise it as success/partial; it settles the run `failed` (via
   * `failRunAndCancelRequests`). Earlier writes stand (P14). Absent / false ⇒ not
   * cancelled.
   */
  cancelled?: boolean;
  /**
   * Race frames whose settlement was DEFERRED under batch resume (asks-as-adapter
   * chunk C, F18/F21): a branch completed but the race was not settled inline, so
   * the resume worker can drive every resolvable branch of the batch to
   * completion first and then settle ONCE with all winners. The worker calls
   * `settleRaceFrame` for each after the batch pass. Absent under inline
   * (timer/cost/ask) resume.
   */
  deferredRaceFrames?: string[];
}

/** A resume's input: the contract's (`engine-contracts`), and the host. */
export interface ResumeMovementInput extends ResumeInput {
  host: EngineHost;
}

/**
 * Whether a run-log entry is an EFFECT on a system — everything but a
 * `match`, which only found a record. Every count of "records written" (the
 * run's write total, the loop guard's budget, the runs list) asks this, so a
 * lookup never reads as a write.
 */
export function isWriteEffect(entry: { kind?: RecordedWrite['kind'] | string }): boolean {
  return entry.kind !== 'match';
}

/**
 * Why a source FILE gave the extraction no text. `extraction_failed` carries
 * the extractor's own sentence alongside it — on a deployment with no OCR
 * provider that sentence names the configuration that is missing, which is the
 * whole difference between "the PDF said nothing" and "nothing read the PDF".
 */
export type FileUnreadableReason =
  | 'unsupported_type'
  | 'bytes_unavailable'
  | 'extraction_failed'
  | 'no_text';

/** One source file on an extraction trace entry: what it is, and either what
 *  it contributed or why it contributed nothing. `truncatedFrom` is the file's
 *  FULL length when only its first `chars` characters reached the prompt — a
 *  ceiling is never silent. */
export type ExtractionTraceFile = { name?: string; contentType?: string } & (
  | { chars: number; truncatedFrom?: number }
  | { unreadable: FileUnreadableReason; detail?: string }
);

/**
 * The extracted text of a source `FileRef`, plus the link back to the
 * stored copy. Mirrors the knowledge pipeline: bytes → OCR/text → RawText
 * → a stable id the field evidence can reference.
 */
export interface FileTextResult {
  text: string;
  /** The `RawText` row the text was deduped/stored into (provenance link). */
  rawTextId?: string;
}

/** A source file the seam could not turn into text, and why — the sentence a
 *  run needs so "extracted nothing" and "could not read the attachment" stop
 *  looking identical. `detail` carries the underlying extractor's own message
 *  (e.g. the OCR-not-configured sentence). */
export interface FileUnreadable {
  unreadable: FileUnreadableReason;
  detail?: string;
}

/** What the `resolveFileText` seam answers with: the file's text, or the
 *  reason there is none. Never a bare absence — a file that was there and
 *  could not be read has to be able to say so. Two callers share it: the
 *  extraction's `from [ … ]` file sources, and the `READ(file)` built-in. */
export type FileTextResolution = FileTextResult | FileUnreadable;

export function isFileUnreadable(
  resolution: FileTextResolution,
): resolution is FileUnreadable {
  return 'unreadable' in resolution;
}

/**
 * One recorded decision point of a firing. Persisted onto the trigger
 * run's step diagnostics and rendered in the run's Recent-activity
 * expansion — the answer to "this run made no changes… why?".
 */
export type MovementTraceEntry =
  | {
      kind: 'field_miss';
      /** The binding read from (`msg`) and the field that was absent. */
      binding: string;
      field: string;
      /** What the event actually carries (capped) — the self-repair hint. */
      available: string[];
    }
  | {
      kind: 'extraction';
      /** The node alias this call was asked about. */
      node?: string;
      /** Characters of source text the call saw. */
      inputChars: number;
      /** What those characters were MADE of — one row per part of the
       *  prompt (each `from` segment by its classification, the current
       *  entity, each enrichment by plugin). A call that read 1.2k where
       *  its sibling read 6.2k is the first thing to look at when one of
       *  them came back empty, and without this the difference takes
       *  archaeology to establish. Capped; the overflow is counted. */
      inputs?: Array<{ classification: string; chars: number }>;
      /** How many prompt parts `inputs` left out at its cap. */
      inputsTruncated?: number;
      /** Every source FILE the `from [ … ]` slots resolved to, readable or
       *  not — the file's name plus either the characters it contributed to
       *  the prompt or why it contributed none. Without this an attachment
       *  nothing could read is indistinguishable from no attachment at all:
       *  the prompt is short (or empty) and the run says only that it read
       *  nothing. Capped. */
      files?: ExtractionTraceFile[];
      /** How many source files `files` left out at its cap. */
      filesTruncated?: number;
      /** Which model answered, and how long it took (both attempts, when
       *  the call was retried). */
      model?: string;
      durationMs?: number;
      /** Present when the answer came back only because the call was asked
       *  less deeply than its tier says: the first attempt spent its whole
       *  output ceiling thinking and wrote nothing, so it was asked again one
       *  effort lower. The answer on this entry is the cheaper one. */
      effortSteppedDown?: { from: string; to: string };
      /** Set when the answer ran past the model's output ceiling and the
       *  client fed the partial text back asking it to continue. Nothing
       *  downstream can tell: the stitched reply parses, the schema is
       *  all-optional, and the records the model never got to at the end of
       *  its input are simply absent. `continuations` counts the turns it
       *  took. A continued reading is a CHUNKING problem — the input was more
       *  than one answer's worth. */
      continued?: true;
      continuations?: number;
      /** Set when the stage was skipped without an LLM call: the extract had
       *  no source text at all (`empty_source`), or this entity's stage
       *  pipeline contributed nothing to read (`no_enrichment`) so the call
       *  would have re-read exactly what the previous stage already saw. */
      skipped?: 'empty_source' | 'no_enrichment';
      /** What each of the stage's plugins did for this entity — `skipped` (a
       *  required argument resolved empty), `empty` (it ran and gave back
       *  neither text nor data), or `dropped` (it brought something back, and
       *  the call that was to fold it in was never answered). The first two
       *  tell "skipped as pointless" apart from "never ran"; the third says
       *  what a fallback cost beyond the fields themselves. */
      plugins?: Array<{ plugin: string; outcome: 'skipped' | 'empty' | 'dropped' }>;
      /** Set when the reply never answered the question — rejected by the
       *  schema on both the first attempt and the retry. `reply` carries what
       *  the model said instead. Fatal for the root call; a per-entity one
       *  carries `fallback` instead of failing the run. */
      failed?: 'invalid_reply';
      /** Present with `failed` when the run carried on regardless: this call
       *  was refining ONE entity that already stood, so the entity keeps the
       *  values its previous stage gave it and this stage's fields join it
       *  absent. The stage's enrichments go with the refinement (`plugins`,
       *  outcome `dropped`). The root call has nothing to fall back to and
       *  never carries this. */
      fallback?: 'kept_previous_stage';
      /** The validation issues that made the engine ask again — present
       *  only when the retry fired. Capped. */
      retried?: string[];
      /** A capped digest of what the model actually replied, kept ONLY
       *  when the call misbehaved (`why` says how): the top-level keys it
       *  answered under — the "answered under `nombre`" class of failure
       *  is unreadable without them — plus the head of the body. A healthy
       *  call never carries one: full replies are expensive to store and
       *  are raw third-party content. */
      reply?: {
        why: Array<'no_entities' | 'dropped_records' | 'retried' | 'failed'>;
        keys: string[];
        sample: string;
        /** Where in the reply the rejection landed, when it named a place.
         *  The `sample` is then the ENTITY sitting there rather than the head
         *  of the body — a complaint about the forty-fifth record is not
         *  legible from the first thousand characters. */
        path?: string;
      };
      /** Entities yielded, by node alias. */
      emissions: Record<string, number>;
      /** `call` on an entry the extraction CALL (`extract(content, Shape)`)
       *  wrote; absent on the keyword's. Its `inputs` are the content items,
       *  one per block, in the author's order. */
      form?: 'call';
      /**
       * How the extraction call used the prompt cache — what measuring the
       * cache-sensitive layout reads. `breakpoints` are the content items
       * whose block ended in a cache breakpoint; `sharedItems` is how many
       * leading items an earlier call in this run had already sent. The token
       * counts are the provider's, across both attempts when the call was
       * retried; absent where the client reported none.
       */
      cache?: {
        breakpoints: number[];
        sharedItems: number;
        inputTokens?: number;
        readTokens?: number;
        writeTokens?: number;
      };
      /** Per node alias, count of emitted entities whose declared fields
       *  all came back null/absent — present only when nonzero. */
      empty?: Record<string, number>;
      /** Per node alias, how many of those empty records the engine
       *  actually DROPPED. Smaller than `empty` when a fieldless parent
       *  survived on its children's evidence — which is the whole reason
       *  the two are counted separately. Present only when nonzero. */
      dropped?: Record<string, number>;
      /** Per `<node>.<field>` key, raw values a CLOSED enum coercion
       *  discarded — a non-member nulled (single select) or dropped from a
       *  multiselect array — so the loss shows up here instead of vanishing
       *  silently. Values are truncated. Present only when nonempty; an
       *  `open` enum (known-values, not closed) never contributes here since
       *  a novel value there is legal, not a loss. */
      coerced?: Record<string, string[]>;
      /** Per `<node>.<field>` key, citations the model wrote as something
       *  other than a string — kept as JSON, as written. The field's VALUE
       *  came through untouched; what was normalised is the quote behind it,
       *  to the one string inside or to nothing. A citation the model simply
       *  omitted never records here: nothing was written, so nothing was
       *  normalised away. Values are truncated; present only when nonempty. */
      evidenceCoerced?: Record<string, string[]>;
      /** How the reply was PACKAGED when the answer came back somewhere other
       *  than under the call's answer key — a bare record, a bare list of
       *  them, or the list keyed under a label the model chose. The content
       *  was right and faced the full entity schema exactly as it would have
       *  in the right place; what was rebuilt around it is the envelope.
       *  Present only when something was rebuilt. */
      envelopeRepaired?: string;
      /** Per node alias, the entities the extract actually produced — what
       *  turns "3 companies" into something a reader can check. Recorded
       *  once the whole extract has materialised, so it covers the root's
       *  own fields and every child alias, not just the call's own region. */
      entities?: Record<string, TracedEntity[]>;
      /** Per node alias, how many entities were left out of `entities`
       *  because the per-alias cap was reached — a cap is never silent. */
      truncatedCount?: Record<string, number>;
    }
  | {
      /**
       * One `through` plugin invocation. The plugins log their own progress,
       * but a log line is not attached to a run — and a retrieval plugin is
       * the longest thing a statement does (a single fetch has a seven-minute
       * backstop), so "what burned the seven minutes" has to be answerable
       * from the run record itself.
       */
      kind: 'plugin';
      plugin: string;
      /** The node whose entity the invocation ran for. ABSENT for a PLAIN call
       *  (`page = fetch_url(url: …)`) — there is no extraction and so no node,
       *  which is the one thing that tells the two forms apart on a trace. */
      node?: string;
      /** The URL the invocation was pointed at, when it took one as an
       *  argument — a fetch that ran to its timeout is identifiable by this
       *  plus `durationMs`. Truncated. */
      url?: string;
      durationMs: number;
      /** Characters of text the plugin fed back into the next call. */
      chars?: number;
      /** Fields the plugin added to the entity's context. */
      fields?: string[];
      /** Set when nothing was invoked: the required argument that resolved
       *  to nothing, so this entity had nothing for the plugin to work on. */
      skippedParam?: string;
      /** How the plugin says the invocation went, in its own vocabulary — a
       *  plugin that stood down, refused to search, or found no confident
       *  match spends real time and attaches nothing, and the fields alone
       *  cannot tell those apart. Free text: the plugin owns its outcomes and
       *  the engine only carries them, so a new plugin is readable on the
       *  trace without the engine learning its words. */
      outcome?: string;
      /**
       * What the CALL handed back — a plain call only. The plugin's own
       * `outcome` says what it made of the work; this says what the LANGUAGE
       * got, which is the fact a reader needs when the next statement did
       * nothing: an absent value and a record of empty fields are different
       * things and look identical otherwise. A stage hands nothing to a name,
       * so it never carries one.
       */
      returned?: 'value' | 'absent';
    }
  /**
   * One `READ(file)` — the file it was pointed at, and either how much text
   * came back or why none did. The LANGUAGE says only `text | absent`, because
   * no absence in it carries a reason; this is where the reason lives, so a
   * movement that read an attachment and got nothing can say whether the file
   * was of a type nothing reads, unreachable, or simply empty.
   *
   * The shape is the extraction's per-file entry verbatim, so a file read
   * through `READ` and a file read as an `extract from [ … ]` source report
   * identically. `truncatedFrom` never appears on one of these: READ does not
   * truncate — the per-file ceiling belongs to what reaches a PROMPT.
   */
  | ({ kind: 'read' } & ExtractionTraceFile)
  /**
   * One `CHUNKS(text, { … })` — how many pieces the text came out in, and how
   * long each one is. The pieces themselves are not here: a trace is read by a
   * person looking for why a run went the way it did, and the text is already
   * in the run. The counts are what answer that — a text that cut into one
   * piece, or into four hundred, explains what happened next.
   */
  | {
      kind: 'chunks';
      pieces: number;
      sizes: number[];
      unit: 'chars';
      /** Which way the author asked for the cut: by characters, or by how
       *  many records a piece is expected to yield. The sizes below read
       *  very differently under the two, so the mode has to be on the entry
       *  rather than inferred from how even they look. */
      mode: 'size' | 'entities';
      /** Entities mode only: what each piece is expected to yield. This is
       *  the number the cut was made on, so a reader comparing it against
       *  what the reading actually produced can see the estimate being wrong
       *  — which is the only way that ever becomes visible. */
      expectedEntities?: number[];
    }
  | { kind: 'ai'; prompt: string; hasValue: boolean }
  /**
   * A warning about the run that did not stop it — a movement pinned to a
   * deprecated language version (`code` is the diagnostic's; `message` names
   * the version and what to do), or a member `MAP` / `FILTER` left out under
   * `onError: "warn"` (`MOVENG_COLLECTION_MEMBER_FAILED`; `message` names the
   * member and why its function failed).
   */
  | { kind: 'warning'; code: string; message: string }
  | { kind: 'gate'; outcome: boolean }
  | { kind: 'block'; root: string; positions: number };

/** One extracted entity as the trace carries it: the declared field names
 *  against display-ready values. A value that came back absent stays
 *  `null` — the whole point is that an unfilled field is visible as one,
 *  not rendered as a missing key. Long values are truncated at capture. */
export interface TracedEntity {
  fields: Record<string, string | null>;
}
