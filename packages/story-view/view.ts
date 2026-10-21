/**
 * The STORY VIEW — the whole contract between the server that projects a
 * movement and the renderer that draws it.
 *
 * It lives beside the components rather than inside the API because two
 * mounts consume it (the workbench panel and the standalone page) and one
 * producer fills it. Type-only, so importing it costs the producer nothing at
 * runtime.
 *
 * Every WORD in here arrived from something an adapter declared — a manifest
 * display name, a vocabulary icon, an instance schema's `displayName`. The
 * renderer never knows a system exists; it prints what it was handed.
 *
 */

import type { Chip, StoryEdge, StoryFilter, StoryProblem, StoryShapeNode, StoryValidity, Step } from 'legacy-lang';

/**
 * Monochrome brand mark for a system, as the adapter declared it — drawn with
 * `fill: currentColor` unless `fill` is false (stroke marks). The renderer
 * draws the path it is handed and keeps no table of its own, which is what
 * stops every system's identity leaking back into the page.
 */
export interface BrandIcon {
  d: string;
  fill?: boolean;
  viewBox?: string;
}

/** One system, as the page shows it. `key` is the adapter's opaque slug and is
 *  never rendered — it exists so two records can be told apart. */
export interface StoryViewSystem {
  key: string;
  label: string;
  icon: BrandIcon | null;
}

export interface StoryViewTrigger {
  id: string;
  /** The whole sentence, ready to print: "When an email arrives at …". */
  sentence: string;
  system: StoryViewSystem | null;
  /** The lane name from `listen as "…"`, when the author named one. */
  lane?: string;
  /** Whether the named movement actually resolved — an unresolved one is a
   *  hole the page must show, not hide. */
  fires: string;
  firesMovement: boolean;
}

export type StoryViewAction = 'create' | 'update' | 'find';

export interface StoryViewRecord {
  id: string;
  /**
   * What the system calls this record type ("Company"). NULL when nothing
   * declared one — a writable-only root mints no position, so there is no
   * type name to show, and saying so is a different fact from showing a name
   * the core made up.
   */
  label: string | null;
  system: StoryViewSystem | null;
  action: StoryViewAction;
  /** "Creates", "Updates", "Finds". */
  verb: string;
  /** The whole card sentence: "Creates a Company in Attio". */
  sentence: string;
  binding?: string;
  fields: Record<string, Chip>;
  fieldModes: Record<string, 'fill' | 'append' | 'append-missing'>;
  uniqueBy: Chip[];
}

/**
 * A traversal with its display vocabulary resolved — the row a for-each header
 * or a race continuation is written out of.
 *
 * The story never sends a traversal as text, so this never has a sentence to
 * hand back either: it resolves the WORDS (what the system calls what each hop
 * lands on) and the page composes the sentence around them. `label` is null
 * where nothing declared a name, exactly as a record's is.
 */
export interface StoryViewTraversal {
  id: string;
  /** `graph` fans out over records in a system; `result` carries on from what
   *  an earlier step produced. NULL ⇒ the script never typed, so nothing is
   *  claimed either way. */
  from: 'graph' | 'result' | null;
  hops: StoryViewHop[];
  /** The path as the author wrote it. The page shows this ONLY when there is no
   *  structure to write a sentence from — a script that cannot be read at all. */
  source: string;
}

export interface StoryViewHop {
  /** The declared edge / collection name — the subject of last resort, and the
   *  natural word for a hop off an earlier step's result. */
  edge: string;
  /** What the system calls what this hop lands on ("Channel"). NULL when
   *  nothing declared one. */
  label: string | null;
  system: StoryViewSystem | null;
  binding?: string;
  filter?: StoryFilter;
}

export interface StoryViewMovement {
  id: string;
  name: string;
  validity: StoryValidity;
}

/**
 * One declared type a REFERENT points at, with what the system calls it.
 *
 * A reference chip carries the address a name resolved to (an adapter slug plus
 * a record type — both opaque); the phrase a reader sees is composed around the
 * label, and the label is a manifest fact, so it is resolved server-side. Rows
 * are matched by their two declared strings, exactly as a record's own label is
 * looked up — nothing constructs a key out of them.
 *
 */
export interface StoryViewType {
  adapterType: string | null;
  recordType: string;
  /** NULL when nothing declared a name — the page then says what it can from
   *  the reference itself rather than inventing a noun. */
  label: string | null;
  /** The system this type belongs to, where one owns it. A node the FILE
   *  declares belongs to none, and says so. */
  system: StoryViewSystem | null;
}

export interface StoryView {
  movement: StoryViewMovement;
  triggers: StoryViewTrigger[];
  records: StoryViewRecord[];
  /** Every traversal the flow walks, resolved. Keyed off the same ids the flow
   *  carries, so a step looks its own up the way a write looks up its record. */
  traversals: StoryViewTraversal[];
  /** Every type a reference in this story points at, resolved. */
  types: StoryViewType[];
  /** The node declarations the file makes — the author's own vocabulary, so it
   *  arrives already said and needs no join. */
  shapes: StoryShapeNode[];
  edges: StoryEdge[];
  /** The authored order, verbatim from the IR — the step list renders it and
   *  looks records up by id. */
  flow: Step[];
}

/** Unreadable source yields no view — never a partial guess. */
export type StoryViewResult =
  | { ok: true; view: StoryView }
  | {
      ok: false;
      reason: 'unreadable';
      movement: { id: string; name: string };
      problems: StoryProblem[];
    };
