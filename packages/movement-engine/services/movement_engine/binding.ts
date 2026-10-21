// The record handle: what a name in a movement is bound to while a run holds
// it (`Binding`), the one constructor that makes one (`binding()`), and the
// mark that tells an engine object from data (`bindingOf`). Both engines hold
// their records in this shape: the TypeScript engine binds every name to one,
// and the Rust engine's shim rebuilds the records the engine hands the host
// (rust_wire.ts) through the same constructor, so a record from either side
// carries the one mark.

import type {
  ClosureExpression,
  InstanceSchema,
  LinkedFile,
  MovementDeclaration,
  NodeLiteral,
  PathHead,
  ShapeDeclaration,
} from 'movement-lang';
import type { CallbackParamSpec, LocalLandingShape, WriteRecord as RecordedWrite } from 'engine-contracts';
import type { SourcePosition } from 'engine-contracts/catalog';
import type { Adapter, Resource } from '../translation_graph/adapter';
import type { Provenance, ProvenanceOrigin } from './provenance';

/**
 * One materialised entity of the extract result graph. The root binding
 * is a single emission (the synthetic "extract result" entity); child
 * edges yield the per-entity emissions, exactly as the language's
 * traversal model expects (`deals-[c:company]->` runs once per child).
 */
export interface ExtractEmission {
  /** The node's name in the tree (the root reads as 'extract result'). */
  nodeName: string;
  /** The node's exported field values — every field it declares, across
   *  all its stages. */
  fields: Record<string, unknown>;
  /**
   * Per-field extraction origins (E4): the interned call-site ref, the
   * field's authored description, and the LLM's verbatim quote — the
   * `{ evidence, value }` wrapping the response already carried, kept
   * instead of dropped at materialisation. Keys ⊆ `fields` keys.
   */
  provenance: Record<string, ProvenanceOrigin>;
  /** The entity's own origin (site-level, no field) — what aggregating
   *  the positions themselves carries. */
  origin?: ProvenanceOrigin;
  /**
   * The SOURCE CONTENT that fed this node's extraction (provenance) — the
   * `from [...]` data materialised as resources: one FILE resource per source
   * `FileRef` (the descriptor kept so a downstream write can carry the
   * file forward) and one TEXT resource per text segment. Every emission of one
   * `extract` shares the same `from` data, so the same list rides the root and
   * every descendant. This is what `extractedNode-[:_resources]->` walks and
   * what the engine attaches to `WriteInput.resources` when the node is written
   * (`4d_resources.md` / Layer 5 provenance). */
  resources: Resource[];
  /** Child node name → emissions. */
  children: Map<string, ExtractEmission[]>;
}

/**
 * A recorded write as the engine holds it: the contract's record, plus the
 * record as it stood before the write — what `-[:@old]->` lands on.
 */
export interface WriteRecord extends RecordedWrite {
  /**
   * The record as it stood before this write, which `-[:@old]->` lands on.
   * Absent when the write created the record — there was nothing before it.
   * A write that found a record holds a snapshot of it as found; a rehearsed
   * one holds its own handle (nothing changed, so before IS after); a write
   * through a handle (`write org { … }`) holds that handle as it stood, whose
   * own `old` keeps the chain. A handle-read surface like `resultData`, never
   * part of the persisted firing record; a park carries it (serialize.ts).
   */
  old?: Extract<Binding, { kind: 'handle' }>;
}

/**
 * Which graph a write handle's record lives in. The linked-write seam
 * (`write h-[:edge]-> { … }`, E3) reads the parent handle's graph to
 * infer the written type from that graph's schema and to route the
 * child write to the same adapter.
 */
export type HandleGraph = {
  kind: 'instance';
  instance: Extract<Binding, { kind: 'instance' }>;
};

/**
 * A traversal STORED rather than run — what `lazy` binds and what a lazy node
 * entry holds.
 *
 * It is a closure, and it is spelled as one: the traversal's own text (root +
 * hop chain, so WHERE / ORDER BY / LIMIT ride along untouched) plus the
 * lexical scope it was written in. Running it is running the ORDINARY head
 * walk against that scope — there is no second walker, which is why the
 * landings are real source positions with real provenance and why a hop's
 * filters behave exactly as they do anywhere else.
 *
 * `captured` is a SNAPSHOT taken where the walk was written, not the live
 * environment: bindings are single-assignment and nothing declared later is in
 * lexical scope for the hop, so the snapshot is exact — and it cannot contain
 * the lazy binding itself, which is what makes serialising it terminate.
 *
 */
export interface DeferredWalk {
  /** The traversal as written — the root's NAME (resolved against `captured`)
   *  and the raw hop chain, re-parsed per walk. */
  head: PathHead;
  captured: Map<string, Binding>;
  /**
   * The PER-ITEM tail (`-> node { … }`), as written. Present = every landing is
   * bound to the hop's alias and synthesised through this literal, so what the
   * walk yields is renamed views rather than the source's own positions. The
   * mapping belongs to the WALK because that is where the renaming happens:
   * deferring the walk defers the synthesis with it, and a park carries the
   * mapping's AST rather than anything it produced.
   */
  mapping?: NodeLiteral;
}

/**
 * One edge of a synthesised node. LANDED holds the positions themselves
 * (nested literals, or an eager traversal already walked); DEFERRED holds the
 * walk, and every read of the edge runs it again against the live source.
 */
export type NodeEdge =
  | {
      kind: 'landed';
      landings: Binding[];
      /** The nested edges every landing the RUN BUILDS on this edge starts
       *  with — present only where the edge was declared by a node
       *  declaration, which is the only thing that says what a landing
       *  carries. A landing that came from somewhere else (a linked handle, a
       *  traversed position) brings its own edges and this says nothing about
       *  it. */
      landingShape?: LocalLandingShape;
    }
  | { kind: 'deferred'; walk: DeferredWalk };


/**
 * The mark every engine object carries and no data can: a private field, which
 * only an object constructed by this class has. Data reaches the engine as
 * JSON or plain objects — an adapter's field value, a webhook body, a plugin's
 * output — and nothing in that data can name a private field, so whatever keys
 * it carries it is never taken for a binding. Not exported: `binding()` is the
 * only way to make one. JSON, the park writer and a spread see only a binding's
 * own enumerable fields, never the mark.
 */
class Bound {
  readonly #brand = true;
  // Every instance is made by `binding()` around a shape, so holding the mark
  // IS being a binding.
  static has(value: unknown): value is Binding {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}

/**
 * One Environment binding: a shape the engine itself made, carrying the mark
 * (`binding()`). The instance binding carries construction
 * data only (slug + credential name); adapter resolution and caching are
 * the interpreter's concern (`run.ts`) so the value model stays inert.
 */
export type Binding = Bound & BindingShape;

/**
 * The ONE constructor of a binding, and the only place a shape becomes one: a
 * fresh marked object holding the shape's fields. A derived binding (a copy
 * with a field changed) comes through here too, because a spread drops the
 * mark — in the type as well as at run time — which is what lets `bindingOf`
 * tell an engine object from data by the mark alone.
 */

export function binding<S extends BindingShape>(shape: S): S & Bound {
  return Object.assign(new Bound(), shape);
}

/** What a binding holds, without the mark: the shapes `binding()` takes. */
export type BindingShape =
  /** The movement parameter — the trigger's event position. */
  | { kind: 'event' }
  /**
   * `import { fetch_url } from plugins` — the name of a plugin, which is a
   * function whose body isn't visible. Nothing runs at the import; the name
   * exists so a CALL on it can be told apart from a call on a movement, which
   * is the same distinction the checker's scope makes.
   */
  | { kind: 'plugin'; plugin: string }
  /** `crm = attio(credentials: acme_main)`. Carries the catalog's
   *  instance schema so borrowed type annotations
   *  (`crm.companies.funding_stage`) resolve live at extraction time
   *  without re-resolving construction. */
  | {
      kind: 'instance';
      name: string;
      adapterSlug: string;
      credentialName?: string;
      /** The non-credential construction args (the Airtable base, the Slack
       *  workspace, …) — what distinguishes two instances of the same adapter
       *  on the same credential. Feeds the binding store's instance key
       *  (`encodeInstanceKey`, translation_graph/movement/record_bindings.ts).
       *  Empty for adapters with no construction config. */
      constructionConfig?: Record<string, string>;
      schema?: InstanceSchema;
    }
  /** `co = write crm-[:company]-> { … }`. */
  | { kind: 'handle'; handle: WriteRecord; targetType: string; graph: HandleGraph }
  /** `deals = extract from […] { … }` — the materialised result graph's
   *  root (a single synthetic emission carrying the top-level fields). */
  | { kind: 'extractRoot'; emission: ExtractEmission }
  /** A traversal alias over an extract edge — one emitted entity. */
  | { kind: 'extractPosition'; emission: ExtractEmission }
  /** A source-graph record yielded by an adapter-edge block head (a
   *  collection fan-out from the meta root, an event schema-edge walk)
   *  — reads go through the source adapter at this position.
   *  `edgeProperties` are the inline properties of the edge it was
   *  reached over, when the adapter returned any (the hop-WHERE read
   *  surface — `edge_property` nodes). `read` is the graph the record
   *  was yielded from, when it is NOT the movement's event source
   *  (instance-/kg-rooted heads) — later reads route through it. */
  | {
      kind: 'sourcePosition';
      position: SourcePosition;
      edgeProperties?: Record<string, unknown>;
      read?: SourceRead;
    }
  /** A traversal alias over `#resources` — one resource of the event. */
  | { kind: 'resource'; resource: Resource }
  /** A traversal-headed block's meta-node: named bindings accumulated
   *  across the block's iterations, one edge per binding name. `plural`
   *  marks a FAN-OUT's value (layer 13 C2): its scalar bindings read as an
   *  ARRAY — always, zero to N entries — where a race receipt (same kind,
   *  no flag) reads its single winner's value bare. */
  | { kind: 'blockMeta'; edges: Map<string, Binding[]>; plural?: true }
  /**
   * A bound traversal-headed block whose iterations RETURNED positions — the
   * landings, in iteration order. Plurality lives here rather than in the
   * position type, exactly as it does for a traversal: reading a field maps
   * over the landings, and a hop continues from each.
   */
  | { kind: 'positions'; landings: Binding[] }
  /**
   * `r = await race([f, g])` — the combinator RECEIPT: one slot per arm, in the
   * arms' own order. A slot holds what its arm RETURNED, whatever that was (a
   * value, a record it wrote), or the null value where the arm handed nothing
   * back — so the receipt is positional data and nothing more.
   *
   * It is not a `positions` binding: those are many of ONE thing, read across
   * (a field maps over every landing). A tuple's slots are separate answers, so
   * the only exact read is by INDEX — `AT(r, 0)` — which is what the checker's
   * tuple type says too.
   */
  | { kind: 'tuple'; slots: Binding[] }
  /**
   * `f = (n: <number>) => { … }` — a CLOSURE: its body as written, and the
   * scope it captured. Both halves are what make it survive a park: the AST
   * rides across as itself (like a `lazy` walk's head), the capture as ordinary
   * serialised bindings.
   */
  | {
      kind: 'closure';
      closure: ClosureExpression;
      captured: Map<string, Binding>;
      /** The name it was bound to (`f = (n) => …`, language version 3), by
       *  which its own body may call it: the capture is a snapshot taken
       *  before the name was bound, so the name is handed to each call
       *  instead (`invokeClosure`). */
      self?: string;
      /** A closure bound at a FILE's top level (the root program's or a
       *  library's): the file scope it reads, held by REFERENCE as a
       *  JavaScript closure holds its module scope — so it sees every
       *  file-level binding, the ones declared after it too — and the name
       *  it is declared by there. `captured` is then empty. A park writes it
       *  by that name and finds it again in the re-parsed file, as it does a
       *  movement: it is a declaration of the program, not run-time data. */
      file?: { name: string; env: Environment };
      /** A closure written in a BODY: the scope it was written in, held by
       *  REFERENCE as a JavaScript closure holds its enclosing scope — so it
       *  reads that scope as it stands when it runs, the bindings made after
       *  it too (names are never rebound, so nothing it read changes).
       *  `captured` is then empty. A park writes the scope once, numbered,
       *  and the closure as its code and that number. Absent on a closure
       *  rehydrated from a park written before (its `captured` snapshot). */
      env?: Environment;
    }
  /** `prompt = "…"` — a plain runtime value, carrying the trail of the
   *  expression that produced it so later reads keep propagating. `many`
   *  marks a walk read for a field (`pdfs = m-[a:Attachments]->.\`File\``):
   *  the value is the walk's collapse (nothing, the one value, or the values),
   *  and a spread reads it as the values (`membersOf`). */
  | { kind: 'value'; value: unknown; provenance?: Provenance; many?: true }
  /** A file-level `shape` declaration — a configuration-free graph;
   *  `write <Shape>.<node> { … }` materialises in-memory positions.
   *  Where it was DECLARED is where its descriptions read their bindings,
   *  wherever an extraction reuses it: `fileEnv` for a file's own
   *  declaration, `library` for an imported one (its environment is built
   *  only if a description actually interpolates). Neither = the running
   *  file's. */
  | {
      kind: 'shape';
      declaration: ShapeDeclaration;
      fileEnv?: Environment;
      library?: LinkedFile;
      /** Declared in a body (or in an `extract(…)` argument) rather than at
       *  file level — not in the re-parsed file scope, so a park carries the
       *  declaration itself rather than its name. */
      local?: true;
    }
  /** A movement declaration — callable (composition, §G). An IMPORTED
   *  movement carries its library's file environment (`fileEnv`): the
   *  callee executes against ITS OWN file scope, not the importer's
   *  (lexical scoping across files). Absent = declared in the running
   *  file; the interpreter falls back to the running file's env. */
  | { kind: 'movement'; declaration: MovementDeclaration; fileEnv?: Environment }
  /** An in-memory shape position (`write Files-[:file]-> { … }`): the
   *  evaluated fields plus their trails. No adapter, no externalId —
   *  the composition argument-adaptation currency. */
  | {
      kind: 'shapePosition';
      shape: string;
      node: string;
      fields: Record<string, unknown>;
      fieldProvenance: Record<string, Provenance>;
    }
  /**
   * `d = node { title: …, company: node { … } }` — a SYNTHESISED node: the
   * in-memory derived position under `node { … }` (the checker's `local` type,
   * at run time). It belongs to no graph, so there is no adapter behind it and
   * nothing to re-resolve: it carries exactly what the literal wrote — the
   * evaluated entry values on the dot plane, and the landings its nested
   * literals synthesised on the arrow plane.
   *
   * Wave 1 is EAGER: every entry was evaluated where the literal was written,
   * so `fields` holds values, not closures. A field carrying a FileRef carries
   * it untouched — nothing here inspects what a value IS.
   *
   * `fieldProvenance` is why this is a binding and not a position read through
   * a derived adapter: the trail of the expression that produced each entry
   * flows through the synthesis untouched, exactly as it does through a shape
   * position. Reading these values back through an adapter seam would replace
   * that trail with a `source_field` origin naming a system that does not
   * exist.
   *
   */
  | {
      kind: 'nodePosition';
      fields: Record<string, unknown>;
      /** The dot plane's names in DECLARATION order — the literal's entries as
       *  written, or the declared node's fields for a landing the run built on
       *  a declared edge. It names every field the record declares, present or
       *  not, and it is what a whole-record read (`recordFields`) walks: a
       *  field map's own key order is neither (a merge appends, and a park
       *  round-trips through jsonb, which reorders keys). */
      fieldOrder: string[];
      fieldProvenance: Record<string, Provenance>;
      /** The edge of a node this run built that this node is a landing on —
       *  set when a write creates it there, or a `link` first appends it. A
       *  landing has identity on that edge (it IS the record, held by
       *  reference), so `write e { … }` updates it in place; a node on no
       *  edge (a literal, an extracted record) has none to update. Also the
       *  name the firing log records an update of it under. */
      landedOn?: string;
      /** The arrow plane: one entry per edge the literal declared, LANDED
       *  (synthesised literals, or a walk already run) or DEFERRED (a `lazy`
       *  hop, walked afresh on every read). */
      edges: Record<string, NodeEdge>;
    }
  /**
   * `files = lazy m-[a:Attachments]->` — a traversal bound WITHOUT being
   * walked. `await`'s dual: the walk is the same walk, at the read instead of
   * here, and it happens again for every read (layer 8 ruling 3 — lazy is pure
   * deferral, not a cache).
   */
  | { kind: 'lazyWalk'; walk: DeferredWalk }
  /**
   * `cb = callback(…)` — the minted deferred invocation. A CHECKER-LOCAL node
   * (typing.ts `local`): it belongs to no graph, so there is no adapter and no
   * position, just what the construct declared — `id` / `url` on the dot plane,
   * and the `Called` edge on the arrow plane, whose landings are read LIVE from
   * the store (the calls arrive after this scope was captured, so they can never
   * be carried on the binding).
   */
  | {
      kind: 'callback';
      callbackId: string;
      url: string;
      /** The fire-time signature, declaration order — the `Called` landing's
       *  fields beyond `At`. */
      params: CallbackParamSpec[];
    }
  /** Imports. A credential import is marked: it is never a value in any
   *  sense, so no read short-cuts past the refusal every other read gets. */
  | { kind: 'opaque'; what: string; credential?: true };

/**
 * The BINDING a runtime value IS, where it is one. A collection op hands each
 * answer back in the currency it arrived in — a binding where the function
 * returned a position (`MAP(pieces, (p) => { return extract … })`), a plain
 * value where it returned one — so a list on the value plane can hold
 * positions, and this is what tells the two apart. By the mark alone, never
 * by the shape: data carrying a `kind` key is still data.
 */
export function bindingOf(value: unknown): Binding | undefined {
  // Only `binding()` sets the mark, so this is true of engine objects alone.
  return Bound.has(value) ? value : undefined;
}

/** A binding a call can run: a movement, a plugin, an import that may be a
 *  movement, or a closure — movements and functions are one thing. */
export function isCallableBinding(binding: Binding): boolean {
  return (
    binding.kind === 'movement'
    || binding.kind === 'plugin'
    || binding.kind === 'opaque'
    || binding.kind === 'closure'
  );
}

/**
 * Lexically-scoped bindings → runtime values. `if` arms interpret in a
 * child environment so arm-local bindings don't leak; everything else is
 * straight program order in one scope.
 */
export class Environment {
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly parent?: Environment) {}

  declare(name: string, binding: Binding): void {
    this.bindings.set(name, binding);
  }

  resolve(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.resolve(name);
  }

  /**
   * The declared name of a FUNCTION in scope (a movement, a plugin, an
   * import, a name bound to a closure) written `name` in another letter case
   * — function names are case-insensitive from language version 3. The
   * checker refuses two functions whose names differ only by case, so at most
   * one answers.
   */
  resolveFunction(name: string): string | undefined {
    const folded = name.toLowerCase();
    for (const [bound, binding] of this.bindings) {
      const callable = isCallableBinding(binding);
      if (callable && bound.toLowerCase() === folded) return bound;
    }
    return this.parent?.resolveFunction(name);
  }

  /** THIS scope's binding of a name, with no parent walk — what a body asks
   *  when it wants the value IT bound, not one an enclosing scope did. */
  resolveOwn(name: string): Binding | undefined {
    return this.bindings.get(name);
  }

  child(): Environment {
    return new Environment(this);
  }

  /** The scope this one is nested in — none for a file's own scope. */
  outer(): Environment | undefined {
    return this.parent;
  }

  /** The bindings declared in THIS scope only (no parent walk) — the
   *  interpreter harvests a block iteration's named bindings into the
   *  block's meta-node from here. */
  ownBindings(): IterableIterator<[string, Binding]> {
    return this.bindings.entries();
  }

  /** This env's lexical chain, ROOT-FIRST (the outermost scope first, this
   *  scope last). The durable-park scope serialiser walks it to capture the
   *  bindings feeding a parked `ask` (async user interaction §4.6). */
  chainFromRoot(): Environment[] {
    const chain: Environment[] = [];
    for (let env: Environment | undefined = this; env; env = env.parent) {
      chain.unshift(env);
    }
    return chain;
  }
}

/**
 * One graph's read seam — the adapter a yielded position reads through,
 * plus the surface-name → fieldId translation its hops consume. The
 * movement's event source is one of these (`MovementExprContext.source`
 * extends it with the seeded position); instance-/kg-rooted traversals
 * carry their own (`graphRead`), threaded onto every position they yield
 * so later reads route to the right system.
 */
export interface SourceRead {
  adapter: Adapter;
  /** The constructed instance (or `kg`) the positions belong to — the
   *  program-level identity source-field origins carry. */
  instanceName: string;
  /**
   * Surface edge name → the fieldId the adapter's `getRelated`
   * consumes, position-sensitive: hops off the meta root are
   * collections (typeId currency), hops off a record are reference
   * fields. Wired by the interpreter from the run's refs; absent =
   * pass-through (fake adapters are surface-name-native).
   */
  edgeFieldId?: (edgeName: string, position: SourcePosition) => string;
  /** The instance's schema, as the catalog assembled it — including the
   *  narrowings the host resolved for this program (`selectedMembers`). Absent
   *  for seams with no schema behind them (an ask's landing, test fakes):
   *  nothing narrows, and every landed record faces the whole WHERE. */
  schema?: InstanceSchema;
}

export type { Bound };
