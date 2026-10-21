# movement-lang — implementation plan (working notes, mine)

Spec: `plans/2026-06-10-data-movement-language/` (round-6 state, commit 052a43ea5).
Strategy: build the **language front-end first** (parser → checker → compile-to-existing-engine),
because the text surface is the spine everything hangs off and it validates the design fastest.
Engine-side attrition increments (write-handles, multi-target — plan OQ15) come behind it.

## Milestones

- **M1 — parse.** Package scaffold; AST; line-oriented lexer; recursive-descent statement
  parser; expression slots captured as raw spans + bridged to the existing formula grammar
  (`packages/movement-lang/expression/formula.ts`). Golden tests: every example in
  `3_syntax_sketch.md` parses; representative error cases.
- **M2 — check.** Scopes & binding (bound-before-read, parallel sibling isolation, block
  meta-node edges), import resolution against an injected catalog interface (adapters /
  credentials / plugins / files), instance construction, write/linked-write validity,
  IS-narrowing, extract-tree validity (final-stage shape, working fields, through arg phases),
  backward field-type propagation. Catalog is an interface so M2 tests run pure; apps/api
  provides the real one later (listEntryPoints/describeTypes manifests).
- **M3 — lower.** Compile the subset today's engine can run (single-instance targets,
  extract→ActionNode tree, traversal blocks, unique by, linked writes→ChildEdge,
  if→BranchNode/orchestration branch) into TG + orchestration structures; run a real
  movement through the dev loop. This is where parity with seed-wave-1 golden path is proven.
- **M4+ — engine attrition.** Write-handles (OQ15 first), per-write instances, parallel,
  block meta-nodes at runtime, through-staged extraction in the extraction planner.

  **Extraction planner (design steer, studied 2026-06-10):** neither existing system is a
  direct target — the ORIGINAL knowledge pipeline (`services/knowledge_pipeline/{tree,extract,
  consolidate}.ts`) is the PLANNING reference (topological phase ordering by data dependency,
  skeleton→properties two-phase, progressive per-entity branching with focused context slices),
  while the TG engine (`engine/evaluator/extract.ts`, `engine/batched_extraction/`) is the
  RUNTIME reference (ephemeral nodes, one batched LLM call per phase, hint collection).
  M4 plan: borrow KP's planner skeleton, decouple it from the ontology DB rows by feeding it
  the checker's inferred extract graph (an in-memory schema registry), keep TG's batching +
  ephemeral materialisation, and replace KP's density-driven two-phase gate with the author's
  explicit `through` fences. M3's lowering to TG #extract steps stands.

## M1 design decisions

- **Line-oriented statements.** Statements and `field: expr` entries are newline-terminated;
  multiline strings and bracketed constructs (`[...]`, `(...)`, `{...}` in expression position,
  backtick names) suspend termination. Keeps expression slicing robust without parsing
  expressions in the statement lexer.
- **Expression slots are raw spans** (`{ raw, loc }`) in the AST, parsed on demand by
  `expression/bridge.ts` → existing formula `parse()`. The bridge:
  - desugars `"a ${x} b"` → CONCAT("a ", <x>, " b") at the formula-AST level (interpolation
    is OUR amendment; the formula tokenizer doesn't know `${}`),
  - permits multiline strings,
  - `==` needs nothing (formula tokenizer already folds `==` → `=`, formula.ts:1035),
  - rejects `EXTRACT_VALUE` / `-[#extract …]->` (retired by amendment 4),
  - takes identity resolvers in M1 (no catalog yet); M2 passes real resolvers.
- **Keyword set (statement layer):** import, from, through, shape, node, edge, movement,
  extract, write, unique, by, if, else, parallel, skip(unused), IS handled by expression
  layer. Lowercase statement keywords; uppercase = expression layer (existing).
- **AST carries source locations** everywhere (line/col) — the checker's whole point is
  precise diagnostics for the agent repair loop.
- **No grammar generator** — hand-rolled recursive descent like formula.ts; consistent with
  repo style, no new deps.

## Worked-example inventory (golden tests, from 3_syntax_sketch.md §)

A header+instances · B writes/unique/linked/edge · C resources block + extract block-value
meta-node example · D extract with through stages · E nightly_mirror program order ·
F if/IS · G shapes + files_to_dropbox + intake (call + inline shape-write arg) ·
I dealflow_intake (parallel, interpolation) + log_dealflow (full extract tree).

## Open implementation questions (carry to the maintainer only if they change the call)

- Where the checker's catalog interface should live so apps/api can implement it without
  a dependency cycle (movement-lang must stay pure; likely: interface in movement-lang,
  impl in apps/api).
- M3 lowering target: TG rows + trigger orchestration vs a direct engine Evaluation —
  decide when M3 starts, against the engine as it then stands.

## M2b state (schema-typed checker — done)

- `checker/typing.ts` is the typed layer: `PositionTypeRef` (meta / position /
  union / handle / extract / blockMeta), `InstanceRef` whose `token` IS the
  introducing ScopeSymbol (graph identity = reference equality), and
  `ExpressionTyping` — the one walker that validates traversals (check 4),
  reads extract fields (check 9), and infers shallow value types for write
  compatibility (check 2). Unknown is ALWAYS silent — the M2a test suite
  doubles as the no-schema regression net.
- `InstanceSchema` (catalog.ts): positions (properties+edges), collections
  (meta-position edges), unions, writableRoots (fields + resultShape).
  Shapes derive the same schema via `shapeToSchema`; `Catalog.kg` carries the
  ontology; extract graphs are inferred (`buildExtractGraph`): node names →
  edges, final-stage fields → properties, earlier stages → working fields.
- Backward propagation LITE: a DIRECT `x.`field`` write into a typed target
  adopts the target type; conflicting adoptions → MOV_EXTRACT_TYPE_CONFLICT
  (strict equality — number vs text conflicts); explicit annotation wins;
  unconstrained reads return no type (untyped, silent) rather than text.
- Bridge: `AGG(<bare path>)` rewrites to a `POSITION_SENTINEL` terminal
  (`COUNT(orgs-[:co]->)`); `AGG(<bare path>).`prop`` moves the property
  inside the traversal. M3 must treat a POSITION_SENTINEL property read as
  "the position itself".
- Narrowing: positive IS conjuncts narrow union params into the if-arm scope
  (and later conjuncts of the same condition). Else-arm elimination NOT
  implemented. `edge a -[:e]-> b` statements are name-checked only (no code
  assigned for edge-existence on handles yet).
- For M3: symbol tables carry everything the compiler needs — instance
  symbols hold their schema, write bindings hold handle types (target root +
  resultShape), extract bindings hold the inferred graph (incl. adopted field
  types → the extraction value types), movement symbols hold decl + lazily
  typed params.

## M4a — write-handles (done 2026-06-10)

- New shared Expression node `{ type: 'action_result', nodeId, field }` —
  serializer-led (`RESULT(nodeId).field`), no parser entry (like `exists`).
- Engine: `EvalContext.actionResults: Map<nodeId, { created, externalId,
  writtenValues, resultData }>` recorded per applied action (dry-run
  included); `resultData` is the adapter `WriteResult.data` bag + top-level
  `url` (previously discarded). Evaluator resolution:
  'created'/'external_id' specials → writtenValues → resultData → null.
- Per-position isolation: `evaluateActionNode` snapshots the map after
  recording its own entry and restores it after the position's children —
  subtree handles don't leak across fan-out positions; the node's own
  entry persists (last emission) for later sibling roots.
- Compiler: same-target-graph handle reads (`co.externalId`, `co.`url``)
  lower to `action_result` over the bound action's id; bound writes carry
  the binding name in their id (`mov-1-co`). Cross-graph reads, handle
  traversal, bare handle values, and reads outside a write's fields stay
  MOV_COMPILE_UNSUPPORTED (M4b: multi-target / per-write adapters — the
  engine needs a per-write targetAdapter before a handle read can pipe a
  value into a different graph's write).

## M4b — per-write targets (done 2026-06-10)

- Engine: optional `ActionNode.targetRef` (SchemaRef) + `targetCredentialsId`.
  `evaluateActionNode` derives a per-node EvalContext (`{ ...ctx,
  targetAdapter }`) via `EvalContext.resolveTargetAdapter` — wired by
  `evaluateTranslationGraph` from the SAME `resolveAdapter` injection point
  as the evaluation-level target (cached per adapterType+credentialsId,
  dry-run-wrapped with the same writeSink). The derived context flows into
  children, so linked writes inherit the parent's effective target; all
  mutable state (actionResults, diagnostics, appliedActionPlans, …) is
  shared by reference. The handle map is pre-allocated on the base context
  before deriving so cross-target handle reads resolve across sibling roots.
- KG mixing WORKS: KG writes go through the same `ctx.targetAdapter` path
  (resolveEntity/create/update + the `adapterType === KG_ADAPTER_TYPE`
  branches in applyActionPlan/ensureBridge/loadLinkedObjectCandidates all
  read the derived context). Known seam: the batcher's `applyTarget`
  (#extract in-batch dedup rules) stays on the evaluation-level target.
  The composition runtime's hop contexts do NOT wire `resolveTargetAdapter`
  — a targetRef body there fails loud.
- Dry-run: `CapturedWrite.adapterType` (the wrapped target's type) so the
  writeSink output distinguishes targets. `AppliedActionPlanRecord.
  adapterType` reflects the override automatically (built from the derived
  context) → trigger_run rows attribute per-action.
- Compiler: `ensureSingleTarget` deleted. Convention: the FIRST write's
  graph is the body-level `targetSchemaRef` (single-target movements emit
  byte-identical M3/M4a bodies); later ROOT writes into other graphs carry
  `targetRef`; linked writes never do (inheritance IS their graph).
  `lowerHandleRead`'s same-graph gate dropped — cross-graph handle piping
  lowers (the runtime currency was already target-agnostic per M4a). Still
  unsupported: parallel, through-staged extract, block meta-node reads,
  calls, write-handle traversal, standalone `edge`, shapes-as-targets.
- Milestone: §I dealflow_intake (email → attio company + slack message +
  affinity organization, parallel rewritten sequential) compiles and
  dry-runs through the real engine with four fakes — three captured writes,
  each attributed to its own adapter, slack text carrying the attio write's
  synthesized externalId.

## M5 — real catalog + persist-then-fire dev-loop proof (done 2026-06-10)

- `movementCatalogForTeam(teamId)` (apps/api `movement/catalog.ts`): adapters/
  construction-args from the manifests; credentials from
  `external_service_credentials` keyed by identifier-safe `name` projection
  (`'Dev Loop Attio'` → `dev_loop_attio`; shared-credential-type adapters get
  slug-suffixed names); instance schemas from REAL
  `listEntryPoints()`/`describe(typeId)` introspection per (adapter,
  credential) — prefetched eagerly (sync `instantiate`), per-pairing
  try/catch → untyped; kg from the team ontology. Pure projections in
  `movement/schema_projection.ts`.
- Surface↔engine currency: positions are sanitized typeId tails
  (`attio:companies` → `companies`, `slack:message` → `message`);
  the catalog returns `CompiledRefMaps` and `movement/resolve_refs.ts`
  rewrites the compiled body back (adapter typeIds; KG NodeTypeId/
  PropertyTypeId UUIDs + edge display names), target-aware per action
  (body-level ref vs per-action `targetRef`, children inherit).
- `provisionMovement` (`movement/provision.ts`): compile w/ team catalog →
  resolveCompiledRefs → `automations.trigger` row (Model A: kind = source
  slug; `config.key` plus-suffix for forwarding-address sources; source
  credentials on the row) → `saveTriggerEntriesForTrigger` (upserts the
  owned `translation_graph` mapping + `{kind:'run_tg'}` orchestration).
  CLI: `pnpm dev:movement provision` (`scripts/dev/movement.ts`).
- Dispatch fix found by the proof: `findTriggerByInboundKey` now expands
  kinds via `resolveAdapterSlug` + `siblingKindsForAdapter` (mirrors
  `findTriggersByKind`) — the mailgun handler keys on legacy
  CUSTOM_EMAIL/MAILGUN kinds while Model A stamps the slug ('email').
- PROOF: email-sourced fixture movement (attio company write + slack
  message reading `co.externalId`) provisioned, fired via
  `dev:inject mailgun-email`, both writes landed in fake-channels with the
  handle value piped; second firing deduped via `unique by (`name`)`.
- Still stubbed: instance `collections`/`unions` (no whole-schema rollup on
  Adapter); json fields project as text; construction args beyond
  `credentials`; ambiguous-credential `instantiate` falls back to the first
  prefetched schema of the adapter.

## M3 seam (mapped 2026-06-10)

Primary target: **direct in-memory evaluation** —
`evaluateTranslationGraph()` in `apps/api/src/services/translation_graph/engine/index.ts:44-119`
takes `{ sourceSchemaRef, targetSchemaRef, body: TranslationGraphBody, trigger: TriggerEvent,
mutationContext, teamId, dryRun?, writeSink?, resolveAdapter? }` → `EvaluationResult
{ appliedActionPlans, errors, diagnostics }`. No storage required; `dryRun + writeSink`
captures writes (the simulate path). `manual_run.ts:40-110` shows the synthetic snapshot
event for meta-rooted runs.

Compile target type: `TranslationGraphBody = { roots: (ActionNode|BranchNode)[]; sourceAlias? }`
(`types.ts:408-459, 603-627`). TriggerEvent shape: `triggers/types.ts:34-73`.

Persist-then-fire (second step): `saveTranslationGraph()` (`storage/index.ts:36`) +
`saveTriggerEntriesForTrigger()` (`storage/tg_table.ts:363`), then
`pnpm dev:inject raw` → webhook handler → `routeTrigger` (`triggers/router.ts:112-200`).

Lowering notes: the engine consumes ONE targetSchemaRef per TG → an M3 movement with one
target instance lowers to one TG; multi-instance movements need either N TGs under an
orchestration or the M4 per-write-adapter engine increment. The compiler lives in apps/api
(or a new module there) since it needs engine types; movement-lang stays pure.

## The final language round (2026-06-11) — listen is the only invoker; query brackets

- **`run` retired (hard, like `edge`)**: the parser rejects the statement with a
  fix-it pointing at the manual channel; RunDeclaration deleted from the AST;
  checker RUN_* codes, completions, and the library-detection rule all swept.
  Runnable = the file declares a MANUAL-channel listener.
- **Cron + manual intrinsic adapters** (apps/api `adapters/cron`, `adapters/manual`):
  credential-free, source-only. `timer = cron()` + `listen to timer { schedule:
  "0 9 * * 1" } fire digest` (five-field cron, UTC, validated at check time by
  `movement-lang/cron` — the SAME parser the scheduler runs); `listen to manual()
  {} fire backfill` (Run-now injects an invocation event carrying the actor,
  through normal dispatch → uniform trigger_run).
- **Inline listen constructions**: `listen to <adapter>(…)` parses into
  `ListenDeclaration.construct`; the fired movement's parameter types against the
  ADAPTER name (`go: <manual-[:invocation]->>`) — credential-free adapter imports are
  their own ambient instance (§A's configuration-free rule), in checker
  (import-time schema, isGraphSymbol) and engine (import binds an instance).
- **AdapterSpec grew `triggerConfigRequired` / `triggerConfigFormats`** (manifest
  `listenConfig`) — required keys + 'cron' value format, projected by the host.
- **Scheduler**: `services/movement_scheduler/worker.ts` — a 30s `lib/worker`
  poll (the platform's only job infra is that interval-loop convention) over
  cron trigger rows; checkpoint column `trigger.cron_last_fired_at`; missed
  occurrences collapse into one tick; cron channels ride listen_subscriptions'
  ensureEventSubscription seam (webhook_subscription.credentials_id now nullable).
- **ORDER BY / LIMIT in traversal brackets**: parsed in formula.ts
  parseBracketContent → EdgeStep.cardinality (orderBy/orderDirection/limit);
  serialized back; checker validates the ORDER BY field on the hop target;
  engine applies order/limit POST-STREAM per origin position (no pushdown) in
  block heads, expression traversals, and EXISTS hops.
- **kg-by-traversal closes the KG_EXISTS/KG_VALUE story**: kg (and any
  constructed instance) roots expression reads, EXISTS, and block heads —
  meta-root collection scans (KG adapter getRelated meta branch; kg collections
  = node types in the schema projection); KG_EXISTS/KG_VALUE flags now point at
  the traversal form. Bracket-WHERE identifiers resolve edge-inline-property
  first, then the DESTINATION field (the language's WHERE semantics).
