// Schema-side types shared by the input filter-authoring surface and the
// (legacy) translation-graph editor. These describe how a side of a graph
// references a schema (KG / adapter / composition) plus the static value
// type that flows through an expression. They are pure types — no behaviour
// — and live here so the kept input-config surface can depend on them
// without reaching into the TG editor tree.

export type {
  Expression,
  TraversalStep,
  EdgeStep,
  LinkBackStep,
  ResourceStep,
  ResourceFilter,
  FilterOperator,
  Selection,
  Aggregation,
} from "movement-lang/expression/types";

/**
 * Static type of a value flowing through an expression. Mirrors F2's
 * `ExpressionType` (apps/api/services/translation_graph/types.ts) — the
 * `generic` schemaRef arm uses these to declare property + edge types
 * in its `GenericShape`. File is a first-class primitive (typed binary
 * handle).
 *
 *   ("E1 — Editor store's `SchemaRef` union has only `knowledge-graph` / `adapter` arms")
 */
export type ExpressionType =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "date" }
  | { kind: "timestamp" }
  | { kind: "json" }
  | { kind: "enum"; values: string[] }
  | { kind: "file" }
  | { kind: "list"; element: ExpressionType }
  | { kind: "record"; fields: Record<string, ExpressionType> };

/**
 * Single edge entry in a `GenericShape`. The destination type is itself
 * an `ExpressionType` — typically a `record` (single neighbour) or
 * `list<record>` (many neighbours).
 */
export interface GenericEdge {
  target: ExpressionType;
}

/**
 * Declared in-memory contract for a TG side using `kind: 'generic'`.
 * Used by composition: an input TG's target shape (`generic_reference`)
 * is materialised into a value of this shape and fed into a standalone
 * TG whose source declares the matching `GenericShape`.
 */
export interface GenericShape {
  properties: Record<string, ExpressionType>;
  edges: Record<string, GenericEdge>;
}

/**
 * Branded id for `knowledge.translation_graph.id`. Mirrors F2's
 * `TranslationGraphId` so the editor store can store + pass it through
 * without redeclaring the brand locally.
 */
export type TranslationGraphId = string & {
  readonly __brand: "knowledge.translation_graph";
};

/**
 * Which adapter's schema interprets a side of the graph.
 *
 * - `knowledge-graph` — the Listen-Fire KG (resolves to the KG adapter).
 * - `adapter` — a concrete external adapter, named by its `adapterType`.
 * - `generic` — declared in-memory shape; used by composition's input /
 *   standalone bridges. Source-side: the standalone TG declares the
 *   contract its caller must materialise. Target-side: the input TG
 *   produces a concrete value of this shape that the caller chains
 *   into the matching standalone source.
 * - `generic_reference` — target-only. Points at a standalone TG whose
 *   `source.shape` matches what this side produces. Composition
 *   materialises the output of this side then re-dispatches into the
 *   referenced standalone.
 *
 * Mirrors F2's canonical `SchemaRef` (apps/api/services/translation_graph/types.ts).
 */
export type SchemaRef =
  | { kind: "knowledge-graph" }
  | { kind: "adapter"; adapterType: string; credentialsId?: string | null }
  | { kind: "generic"; shape: GenericShape }
  | { kind: "generic_reference"; tg_id: TranslationGraphId };

/**
 * N3 source/target kinds carried from the canonical API union
 * (apps/api/services/translation_graph/types.ts). They are NOT part of the
 * editor's introspectable {@link SchemaRef} union — they don't dispatch
 * through an adapter the editor introspects — but a stored TG body can hold
 * one, and the flat source/target picker has to reflect / set them:
 *
 * - `dynamic` — the trigger's raw adapter feed (e.g. inbound email). Surfaced
 *   so a stored `dynamic` source reflects truthfully ("Inbound email" rather
 *   than mis-defaulting to the KG).
 * - `static` — a named reusable `schema_type` row (a "normalised input"),
 *   shared between chained steps.
 *
 * Stored on `graph.{source,target}SchemaRef` (cast in from the body JSON);
 * the picker reads them structurally and never feeds them to the introspection
 * endpoints (which only accept {@link SchemaRef}).
 */
export type N3SchemaRef =
  | {
      kind: "dynamic";
      adapterKind: string;
      // Object-type discriminant — which feed variant this edge consumes
      // (an `EventType.positionType`, e.g. `attio:companies`, or a KG node-type
      // id). Set when the Read-from picker chooses a specific event type.
      objectType?: string;
      credentialsId?: string | null;
    }
  | { kind: "static"; schemaTypeId: string }
  // A freshly-created action that hasn't been pointed at a destination yet.
  // The picker shows "Select…" (no option matches) until the author chooses;
  // saving an orchestration that still references it is blocked by the
  // validator. Keeps "no destination" honest instead of defaulting to the KG.
  | { kind: "unset" };

/** Either an introspectable {@link SchemaRef} or an {@link N3SchemaRef}. */
export type AnySchemaRef = SchemaRef | N3SchemaRef;
