// `@lf/kg`'s declarations: the adapter type, and the manifest the host lists
// the graph by without loading it.

import type { AdapterManifest } from '@listen-fire/engine/public/adapter';
import type { WireInboundDeclarationShape } from '@listen-fire/engine-contracts';

import { KNOWLEDGE_GRAPH_HANDBOOK_SECTION } from './handbook_section';

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`, and
 *  IS the import name a movement constructs the graph through
 *  (`` import { `@lf/kg` as kg } from adapters `` ⇒ `graph = connect kg`). */
export const KG_ADAPTER_TYPE = 'kg';

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
      'preprocessInbound', 'awaitKeys',
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
    // The graph's model is per-team and user-editable, so describing an instance
    // is a live read of THIS team's ontology rather than a static constant.
    introspectedSchema: true,
    triggerExpectation:
      "Listen on a record's Changes: graph-[t:`Support Ticket`]->-[c:Changes WHERE c.Kind == \"updated\"]->. " +
      "It fires when a record of that type in the team's knowledge graph is created, updated or deleted, " +
      'whoever changed it: a person, an agent, or another automation. A change names what moved ' +
      '(`Changed Fields`) and carries the record as the change left it (`Current`). An automation that ' +
      'listens to a type and writes to it can wake itself: Listen-Fire stops a listen whose runs keep ' +
      'changing the records it hears, and narrowing the listen to the changes it means avoids that.',
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
