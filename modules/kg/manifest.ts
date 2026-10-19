// `@lf/kg`'s declarations: the adapter type, the event surface every listen
// to the graph names, and the manifest the host lists the graph by without
// loading it.

import type { AdapterManifest } from 'movement-engine/public/adapter';
import type { WireInboundDeclarationShape } from 'engine-contracts';

import { KNOWLEDGE_GRAPH_HANDBOOK_SECTION } from './handbook_section';
import { KG_SUBSCRIBABLE_EVENTS } from './events';

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`, and
 *  IS the import name a movement constructs the graph through
 *  (`` import { `@lf/kg` as kg } from adapters `` ⇒ `graph = connect kg`). */
export const KG_ADAPTER_TYPE = 'kg';

// ── The event surface (D40) ─────────────────────────────────────────────────
// The graph publishes an EVENT ENTRY exactly like every other adapter — the
// same shape Airtable's `Record Change` has, for the same reasons. Nothing
// here is graph-specific machinery: a listen names the watched node type, the
// change kind is the event node's own `action` field, and the changed record
// is REACHED over the event's `Record` edge rather than being the event.

/** The event node's own type name. JUST A NODE: its change kind is its
 *  `action` field, narrowed in the address —
 *  `<graph-[:`Record Change` WHERE `action` == "record.created"]->>`. */
export const KG_EVENT_TYPE_NAME = 'Record Change';
/** The dispatch id for the event node (its `describe` / `getRelated` currency);
 *  the display name above is what an author writes. */
export const KG_EVENT_TYPE_ID = 'kg:record_change';
/** The event node's edge to the changed record. */
export const KG_EVENT_RECORD_EDGE = 'record';
/** Its NATURAL name — Title Case, the one convention across adapter surfaces. */
export const KG_EVENT_RECORD_EDGE_NAME = 'Record';

/**
 * The meta collection whose members are this team's node types.
 *
 * `Base`/`Table` for the graph: the node the `type:` listen hop selects a
 * member of, and the type the event's `Record` edge lands on before anything
 * says WHICH node type. Its members ride the root hop's `targetPositions`, each
 * publishing `Id` — the name a listen writes, which for the graph IS the node
 * type's identity (the ontology UUID stays adapter-private, in the structured-id
 * cache and the SQL).
 */
export const KG_NODE_TYPE_META_TYPE = 'Node Type';

/** Synthetic target type for the `#resources` reference — a `node_resource`
 *  attachment surfaced as a resource position. The id IS the natural display
 *  name: it rides schema edge targets and landed positions, both agent-visible
 *  surfaces (the leakage audit's rule — an id that can surface must read as a
 *  name, never as adapter plumbing). */
export const KG_RESOURCE_TYPE_ID = 'Attached Resource';

/** The name a node's resources edge is walked by — `c-[f:Resources]->`. It is
 *  an ordinary declared edge; the reserved `_resources` fieldId it is keyed by
 *  is the adapter's own (versions 1–4 of the language walked it as
 *  `c-[f:_resources]->`). A display name only: `getRelated` matches the edge
 *  by that fieldId, so a team's ontology edge named `Resources` stays the
 *  ontology's. */
export const KG_RESOURCES_EDGE_NAME = 'Resources';

/** The credential type a connection to the graph is stored under. */
export const KG_CREDENTIAL_TYPE = 'NATIVE_KNOWLEDGE';

/** The provider key the store's signed change events arrive under (also the
 *  listen trigger kind), and how they are signed: bare hex HMAC-SHA256 of the
 *  body, in the header the platform's outboxes have always used, keyed with
 *  the secret the store issued when the webhook was registered. */
export const KG_INBOUND: WireInboundDeclarationShape = {
  providerKey: 'kg_mutation',
  scheme: 'attio',
  signatureHeaders: ['attio-signature', 'x-attio-signature', 'x-airtable-content-mac', 'x-webhook-signature'],
  secretIssuedBy: 'provider',
};

/**
 * The manifest — the construction-free declaration the host lists the graph
 * by. `createRecord`/`updateRecord`/`deleteRecord` are genuine writes;
 * `linkRecords`/`unlinkRecords` assert and sever edges between existing nodes.
 *
 * The subscription half is declared only where it is real. A deployment
 * carries the store's change events exactly one way (D39(c)): where the store
 * runs beside the host, the host takes them straight off the store and there
 * is nothing to register — advertising the methods would make the listen
 * reconciler provision a webhook nothing ever posts to, a subscription that
 * looks live and never fires. Where the store is a different process, its
 * signed POST IS the delivery, and the methods are declared.
 */
export function kgManifest(input: { changeWebhooks: boolean }): AdapterManifest {
  return {
    adapterType: KG_ADAPTER_TYPE,
    displayName: 'Knowledge Graph',
    description:
      "Listen-Fire's own store — the structured records your data model defines. " +
      'Movements can read it, write to it, and run whenever something in it changes.',
    supportedTriggers: ['mutation'],
    methods: [
      'listEntryPoints', 'describe', 'resolveEntity', 'getDedupRules',
      'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord',
      'linkRecords', 'unlinkRecords',
      // Echo-authorship capability — gates the opt-in `suppress_self` listen
      // flag (the KG answers from its own mutation-context provenance).
      'didWeAuthor',
      'preprocessInbound',
      ...(input.changeWebhooks ? (['ensureEventSubscription', 'removeEventSubscription'] as const) : []),
    ],
    // The graph is reached with a stored credential, like every other system
    // (D25) — which is also what makes it OPTIONAL: a team with no
    // connection simply has no `kg` in its catalog, because the registry's
    // presence gate reads this. `intrinsic` because there is no third party to
    // sign in to: the server provisions the key against the configured instance.
    // `connect: 'intrinsic'` is not stated here — it is DERIVED from the type
    // having an intrinsic provisioner (`connectKindForType`), so the two cannot
    // disagree about whether one-click provisioning exists.
    requiredCredentialType: KG_CREDENTIAL_TYPE,
    triggerKinds: ['KG_MUTATION'],
    // The change kinds a listen subscribes to, in the platform's uniform
    // `record.*` currency (D40) — ONE namespace with attio and airtable, and the
    // same values the event node's `action` field enumerates.
    subscribableEvents: [...KG_SUBSCRIBABLE_EVENTS],
    // The graph's model is per-team and user-editable, so describing an instance
    // is a live read of THIS team's ontology rather than a static constant.
    introspectedSchema: true,
    // `type` is the ADDRESS of the record the event's `Record` edge lands on: a
    // listen is shorthand for a WHERE, so naming the watched type here is what
    // narrows the edge, and the author never restates it in the movement. It
    // matches on `Id`, which for the graph IS the node type's name — the
    // framework identity the entry points publish (the ontology UUID never rides
    // a position). `fields` is the changed-attribute filter: bare property names
    // of the watched type. `events` needs no entry — `subscribableEvents`
    // projects it — and `suppress_self` is universal, validated centrally for
    // every adapter, so neither is declared here.
    listenConfig: [
      {
        key: 'type',
        required: true,
        narrows: { collection: KG_NODE_TYPE_META_TYPE, matchField: 'Id' },
      },
      { key: 'fields', format: 'fields' },
    ],
    triggerExpectation:
      "Fires when a record in the team's Listen-Fire knowledge graph is created, " +
      'updated or deleted — whether a user edited it, an agent wrote it, or ' +
      'ANOTHER MOVEMENT wrote it. That last case can loop a movement that ' +
      'both listens to and writes the same types: narrow the listen to ' +
      'specific types/changes, and use suppress_self where the movement ' +
      'should ignore its own writes.',
    handbookSection: KNOWLEDGE_GRAPH_HANDBOOK_SECTION,
    vocabulary: {
      // No brand mark — the KG is intrinsic, not a third-party system.
      eventPhrase: {
        // No per-event phrasing today (create/update/delete all shared one
        // generic sentence in the former switch) — `default` mirrors that.
        default: [{ template: 'When data changes in your knowledge graph' }],
      },
    },
  };
}
