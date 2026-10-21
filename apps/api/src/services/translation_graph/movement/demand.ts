// The compile path's demand set (2026-07-05) — the second half of the
// position-aware pre-scan (the first half is refinements.ts).
//
// The program's text says exactly which types the compiler will inspect, so
// the compile path describes ONLY those instead of the adapter's full
// surface. Two pure pieces feed the loop in catalog.ts:
//
//   - `demandSeed`: the entries the program NAMES. Natural names are
//     authored verbatim (write roots, param shapes, collection hops, IS
//     tests, extract borrows), so a textual match over the sources is a
//     sound over-approximation — a false hit costs one spare describe, a
//     type the program never names is a type the checker never inspects by
//     name. Event-position entries are always demanded: listens, event
//     variants, and the projection's event heuristic need them regardless.
//
//   - `closeDemandOverChains`: the RECURSIVE CLOSURE along the program's
//     traversal paths — hop targets whose EDGE name differs from the type
//     name never appear textually, so each round walks the scanned chains
//     over the interim schema and demands every position they land on,
//     until a round adds nothing.
//
// Soundness rests on the projection + checker contract: projecting the FULL
// entry list with only the demanded descriptors keeps `collections`
// complete, and every undescribed position projects OPEN — which the
// checker treats as "surface not enumerated", staying silent rather than
// wrong. Anything the closure might miss degrades to silence.

import type { InstanceSchema } from 'movement-lang';
import type { InstanceChain } from 'legacy-lang';

export interface DemandEntry {
  typeId: string;
  displayName: string;
  collectionName?: string;
  /** The entry is an event edge (`SchemaEntryPoint.fires`) — always demanded:
   *  the event node's own fields (its `action` enum, its address properties)
   *  are what listens and signatures type against. */
  fires?: boolean;
}

/**
 * The typeIds the program names textually, plus every event-edge entry.
 *
 * The match is a deliberate over-approximation — a substring hit against raw
 * source text — because a false hit costs one spare describe and a miss costs
 * a wrong answer.
 *
 * Worth knowing before it surprises you: this is ALSO what makes an Airtable
 * container walk reach the right base. A movement naming `` `CRM — Companies` ``
 * demands the base `CRM` too, because "CRM" is a substring of the table's
 * qualified name — so the checker walks meta → CRM → Companies without parsing
 * anything, and the base's hop teaches the path to the table. It is sound (the
 * false hit costs one spare BASE describe, one API call), but it works by
 * coincidence of the `"<Base> — <Table>"` naming convention rather than by
 * design: change the shape of that name and this silently stops reaching the
 * base, degrading the table hop to the full-workspace name lookup.
 *
 */
export function demandSeed(input: {
  entries: readonly DemandEntry[];
  /** Raw program text — substring matched, per the over-approximation above. */
  sources?: readonly string[];
  /**
   * Pre-extracted NAMES (`referencedNames(source)`) — the editor's form, since
   * it cannot send raw source (a tRPC query's input rides in the URL).
   *
   * Matched by the SAME substring rule as `sources`, with each mention standing
   * in for the text it came from. Exact equality is the tempting simplification
   * and it silently breaks both properties this over-approximation exists for:
   * a hop spelled `-[:Notes]->` would stop demanding the entry `Note`, and a
   * movement naming `` `CRM — Companies` `` would stop demanding the base
   * `CRM` — which is the Airtable walk described above, degrading the table hop
   * back into the full-workspace lookup this model exists to kill.
   *
   * It shares this function rather than having its own, because it briefly DID
   * have its own and dropped the `fires` clause below — so an event type the
   * program did not spell literally went undescribed and the editor reported
   * `has no position type 'Invocation'` on a correct movement. Two demand
   * rules is one too many.
   */
  mentions?: readonly string[];
}): Set<string> {
  const demanded = new Set<string>();
  const haystacks = [...(input.sources ?? []), ...(input.mentions ?? [])];
  for (const entry of input.entries) {
    const named = haystacks.some(
      (text) =>
        text.includes(entry.displayName) ||
        (entry.collectionName !== undefined && text.includes(entry.collectionName)),
    );
    // EVERY firing entry, named or not. A listen-driven movement need never
    // spell its event type — the address in its signature is not a bare name —
    // so demanding only what is named leaves the event position undescribed and
    // the checker calls the program's own parameter type unknown.
    if (named || entry.fires === true) demanded.add(entry.typeId);
  }
  return demanded;
}

/**
 * The per-variant TYPE NAMES a described type's discriminated write declares.
 *
 * A discriminated write body is a union whose members are OTHER types
 * (`listName: "Pipeline"` selects `List Entry — Pipeline`). Those names appear
 * nowhere in the program — the author writes the LITERAL, not the type — and
 * nothing hops to them, so neither the textual seed nor the chain closure
 * reaches them. Undemanded, they are never described, and every variant
 * silently collapses onto the base shape: the body is checked against the
 * common fields alone, so the list-scoped fields that are the whole point of
 * the discriminant are neither accepted nor rejected on their merits.
 *
 * Bounded: one describe per DECLARED variant of a type the program already
 * demanded — the adapter chose that member set. Never a workspace scan.
 *
 * (Attio escaped this only by coincidence: its variant type names ARE the bare
 * list names, so writing `listName: "VC Deal Flow"` puts that string in the
 * source and `demandSeed`'s substring match demanded it. One rename and it
 * would have fallen into the same hole.)
 */
export function closeDemandOverWriteVariants(
  descriptors: ReadonlyMap<string, { discriminatedWrite?: { variantTypes: Record<string, string> } }>,
): Set<string> {
  const touched = new Set<string>();
  for (const descriptor of descriptors.values()) {
    const variantTypes = descriptor.discriminatedWrite?.variantTypes;
    if (variantTypes === undefined) continue;
    for (const typeName of Object.values(variantTypes)) touched.add(typeName);
  }
  return touched;
}

/** Every position NAME the chains land on, walking the interim schema. */
export function closeDemandOverChains(input: {
  schema: InstanceSchema;
  chains: readonly InstanceChain[];
}): Set<string> {
  const touched = new Set<string>();
  // The edge targets reachable from a NAME: a position's own edge, or — when
  // the name is a UNION (an event param typed as the union: `<chat-[:`Message
  // Received`]->>`) — that edge on EVERY variant. The variants are positions
  // (`Record Created`, …) and they carry the event's `record` edge; without
  // this the closure stopped dead at the union and the record's type was
  // never demanded — reads through `e-[r:record]->` then projected
  // undescribed. (Airtable never hit it: its listens graft the narrowed
  // table. Email never hit it by luck: 'Email' is a substring of 'Email
  // Received', so the textual seed covered it.)
  //
  //
  // The edge may live on the type's WRITE shape rather than a readable
  // position: a write-only type (an ask family — you write a `Check`, you never
  // read the collection) mints no position at all, and its `Response` edge is
  // declared on the create shape. The checker resolves a handle's hops through
  // exactly this fallback; the closure has to, or the awaited landing is never
  // described and the answer reads as undescribed.
  const edgeTargetOn = (name: string, edge: string): string | undefined =>
    input.schema.positions[name]?.edges[edge]?.target ??
    input.schema.writableRoots[name]?.edges?.[edge]?.target ??
    input.schema.createShapes?.[name]?.edges?.[edge]?.target;
  const targetsFrom = (name: string, edge: string): string[] => {
    const own = edgeTargetOn(name, edge);
    if (own !== undefined) return [own];
    const variants = input.schema.unions?.[name] ?? [];
    const out = new Set<string>();
    for (const variant of variants) {
      const target = edgeTargetOn(variant, edge);
      if (target !== undefined) out.add(target);
    }
    return [...out];
  };
  for (const chain of input.chains) {
    // A param/handle-rooted chain starts at a position type, not the meta
    // position — demand the start itself so its surface (and writability)
    // is described, then walk its edges.
    if (chain.startPosition !== undefined) touched.add(chain.startPosition);
    let current: string | undefined = chain.startPosition; // undefined = the meta position
    for (const step of chain.steps) {
      if (step.type !== 'edge') break;
      const targets =
        current === undefined
          ? [input.schema.collections[step.edgeTypeId]?.target].filter(
              (t): t is string => t !== undefined,
            )
          : targetsFrom(current, step.edgeTypeId);
      if (targets.length === 0) break; // undescribed / unknown — next round or silence
      for (const target of targets) {
        // A UNION target is a DERIVED address, not a type the adapter can
        // describe — its MEMBERS are, and they are what a read through the hop
        // resolves against. Demanding the key itself asks the adapter to
        // describe a name it has never heard of, and leaves every variant
        // undescribed: the hop then lands on a union of surfaces nobody looked
        // at, so narrowing degrades to silence exactly where it should speak.
        const variants = input.schema.unions?.[target];
        if (variants !== undefined) {
          for (const variant of variants) touched.add(variant);
        } else {
          touched.add(target);
        }
      }
      // Variants disagreeing on the landing is a real (future) shape; demand
      // every landing but only keep walking when it is unambiguous.
      if (targets.length > 1) break;
      current = targets[0];
    }
  }
  return touched;
}
