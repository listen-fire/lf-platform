// A saved file's listens as this release plans them: what provisioning keeps
// on each listen's trigger row, so the door judges an arrival without
// checking the program again (inbound/listen_door.ts), and the edge poll
// worker knows which listens it polls for (poll_source/worker.ts).

import { checkAnswerInRust } from 'movement-engine/public/movement-engine';
import {
  fieldIdsOf,
  landingNode,
  listenPlansOf,
  listenSchemaOf,
  plannedListensOf,
  triggerAwaitsOf,
} from 'movement-engine/public/inbound';

import type { ListenPlan } from 'engine-contracts';
import type { CatalogSnapshot, EdgeListening, InstanceSchema, LanguageVersion, Program } from 'movement-lang';
import type { ListenConfig } from '../../inbound/listen_door';

/** Why this host would not fire `plan` as written, if it would not: only
 *  listen-fire lists the members of an earlier hop whose WHERE an arrival
 *  does not carry the record for (a `resolved` hop). Judged here with that
 *  hop unjudged, it would fire under every member. */
function unfiredHere(plan: ListenPlan): string | null {
  const resolved = plan.hops.filter((hop) => hop.judged === 'resolved').map((hop) => `\`${hop.edge}\``);
  if (resolved.length === 0) return null;
  return `the listen that fires ${plan.movement} filters ${resolved.join(', ')} by a WHERE its module's arrivals do not carry the record for: this host cannot judge it, and would fire under every one. Filter that hop on the landing's fields instead`;
}

/** How the arrivals on `plan`'s last edge reach the host, as `schema` (its
 *  connection's) declares that edge or root collection. */
function deliveryOf(schema: InstanceSchema | undefined, plan: ListenPlan): ListenConfig['delivery'] {
  const last = plan.hops.at(-1);
  if (schema === undefined || last === undefined) return undefined;
  const declared: EdgeListening | undefined = last.from === '' ? schema.collections[last.edge] : schema.positions[last.from]?.edges[last.edge];
  if (declared?.delivery === undefined) return undefined;
  return { kind: declared.delivery, ...(declared.pollEverySeconds !== undefined ? { pollEverySeconds: declared.pollEverySeconds } : {}) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Each listen of the file `file` (its `source`, parsed as `program`, checked
 * against `snapshot` under `pin`): its plan and pipeline, its connection's
 * construction, the edges its function awaits off what a delivery hands it,
 * the field ids its records are read by, and the node it states its landing
 * is. A listen this host would not fire as written is refused by name.
 */
export function plannedListensOfSource(input: {
  file: string;
  source: string;
  program: Program;
  snapshot: CatalogSnapshot;
  pin: LanguageVersion;
}): { listens: ListenConfig[]; refused: string[] } {
  const answer = checkAnswerInRust({ source: input.source, catalog: input.snapshot, languageVersion: input.pin });
  const planned = plannedListensOf({ file: input.file, program: input.program, plans: listenPlansOf(answer) });
  const listens: ListenConfig[] = [];
  const refused: string[] = [];
  for (const listen of planned) {
    const why = unfiredHere(listen.plan);
    if (why !== null) {
      refused.push(why);
      continue;
    }
    const { landing: node } = listen.plan;
    let landing: ListenConfig['landing'];
    if (node !== undefined) {
      try {
        landing = landingNode({ source: input.source, node });
      } catch (error) {
        landing = { unread: messageOf(error) };
      }
    }
    const schema = listenSchemaOf(input.snapshot.adapters[listen.plan.adapter], listen);
    const delivery = deliveryOf(schema, listen.plan);
    listens.push({
      pipeline: listen.pipeline,
      plan: listen.plan,
      ...(listen.credentialName !== undefined ? { credentialName: listen.credentialName } : {}),
      ...(listen.constructionArgs !== undefined ? { constructionArgs: listen.constructionArgs } : {}),
      awaits: triggerAwaitsOf({ program: input.program, stamps: answer.stamps, plan: listen.plan }),
      fieldIds: fieldIdsOf(schema),
      ...(landing !== undefined ? { landing } : {}),
      ...(delivery !== undefined ? { delivery } : {}),
    });
  }
  return { listens, refused };
}
