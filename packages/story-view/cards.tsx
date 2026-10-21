"use client";

import type { StoryEdge, StoryEndpoint, StoryNode } from 'legacy-lang';
import type { StoryViewRecord, StoryViewTrigger } from "./view";

import { BrandMark } from "./brand-mark";
import { BOX, LIFT } from "./canvas-style";
import { FieldChips } from "./chips";
import { Alias, AliasChip } from "./referents";
import { readable } from "./pannable-surface";
import { NODE_MAX } from "./sizing";

/**
 * The nodes of the canvas: what starts a run, and the things a step touches.
 *
 * A card carries its own connections as words. The canvas draws CONTROL flow
 * top-to-bottom, so a line between two cards means "then"; a line that meant
 * "belongs to" instead would put two different orders in one picture, which is
 * exactly what the first canvas got wrong.
 *
 */

export function TriggerCard({ trigger }: { trigger: StoryViewTrigger }) {
  return (
    <div
      {...readable(`w-full min-w-0 ${NODE_MAX} border border-primary-100 bg-primary-50 px-3.5 py-3 ${BOX} ${LIFT}`)}
    >
      <div className="flex min-w-0 items-center gap-2 text-primary-700">
        <BrandMark system={trigger.system} />
        <span className="min-w-0 text-[11px] font-medium uppercase tracking-[0.06em] [overflow-wrap:anywhere]">
          {trigger.system?.label ?? "Something happens"}
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-snug text-gray-700 [overflow-wrap:anywhere]">
        {trigger.sentence}
      </p>
      {trigger.lane && (
        <p className="mt-1 text-[11px] text-gray-400 [overflow-wrap:anywhere]">
          {trigger.lane}
        </p>
      )}
      {!trigger.firesMovement && (
        <p className="mt-1.5 text-[11px] text-amber-700">
          Nothing here is called “{trigger.fires}”.
        </p>
      )}
    </div>
  );
}

/**
 * A write, as a card. Every write, including the one an ask raises: a question
 * put to a person is a record like any other, and dressing it differently hid
 * its fields — which are the question. The PAUSE is the await, and the canvas
 * draws that as the cut it makes across the flow.
 *
 */
export function RecordCard({
  record,
  relations,
}: {
  record: StoryViewRecord;
  /** "Linked to Companies as Team" — one line per relation this record hangs
   *  off. Words on the card, never a line across the picture. */
  relations: string[];
}) {
  return (
    <div
      {...readable(`w-full min-w-0 ${NODE_MAX} border border-gray-200 bg-white px-3.5 py-3 ${BOX} ${LIFT}`)}
    >
      <div className="flex min-w-0 items-center gap-2 text-gray-500">
        <BrandMark system={record.system} />
        <span className="min-w-0 text-[11px] font-medium uppercase tracking-[0.06em] [overflow-wrap:anywhere]">
          {record.label ?? record.system?.label ?? "Something"}
          <Alias name={record.binding} />
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] font-medium leading-snug text-gray-800 [overflow-wrap:anywhere]">
        {record.sentence}
      </p>
      <FieldChips fields={record.fields} />
      {record.uniqueBy.length > 0 && (
        <p className="mt-2 text-[11px] text-gray-400 [overflow-wrap:anywhere]">
          Matched on {record.uniqueBy.map((chip) => chip.source).join(", ")}
        </p>
      )}
      {relations.map((relation) => (
        <p
          key={relation}
          className="mt-1.5 text-[11px] text-gray-400 [overflow-wrap:anywhere]"
        >
          {relation}
        </p>
      ))}
    </div>
  );
}

/**
 * A step that is not a write, as a card — and it is the SAME card, because it
 * is the same kind of thing: a box on the spine that does something.
 *
 * The anatomy comes from the write card, which reads right. An EYEBROW saying
 * what the step is, in the place a write says whose system it is writing to.
 * The name the script gave what the step produced BESIDE that eyebrow, in the
 * place a write carries its own binding — never inside the sentence, where it
 * was the one word in an English line that nobody but the author could read.
 * Then the sentence. Then whatever the step carries — a prompt, a template — in
 * its own well below the chrome, so the content of the step and the words
 * describing it are not the same run of text.
 *
 * Every eyebrow is a word for what the step IS ("AI", "Value", "Removes"),
 * derived from what it does; none of them is the language's name for it.
 *
 */
export function StepCard({
  signpost,
  icon,
  tone = "plain",
  alias,
  sentence,
  children,
}: {
  signpost: string;
  icon: React.ReactNode;
  /** An AI value is violet wherever it appears; everything else is quiet. */
  tone?: "plain" | "ai";
  /** What the script calls what this step produced. */
  alias?: React.ReactNode;
  sentence?: React.ReactNode;
  /** The step's own content — a value, a set of fields. */
  children?: React.ReactNode;
}) {
  return (
    <div
      {...readable(`w-full min-w-0 ${NODE_MAX} border border-gray-200 bg-white px-3.5 py-3 ${BOX} ${LIFT}`)}
    >
      <div
        className={`flex min-w-0 flex-wrap items-center gap-x-2 ${
          tone === "ai" ? "text-violet-600" : "text-gray-500"
        }`}
      >
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 text-[11px] font-medium uppercase tracking-[0.06em] [overflow-wrap:anywhere]">
          {signpost}
        </span>
        {alias}
      </div>
      {sentence !== undefined && (
        <p className="mt-1.5 text-[12.5px] leading-snug text-gray-700 [overflow-wrap:anywhere]">
          {sentence}
        </p>
      )}
      {children !== undefined && <div className="mt-2 min-w-0">{children}</div>}
    </div>
  );
}

/**
 * A node the author put together — written inline as an argument, or bound to a
 * name. It belongs to no system, so there is no mark and no verb; what there is
 * is what a reader came for, the same as any other card: its fields, and what
 * fills them.
 *
 * The heading is a PHRASE, and the script's own name for the thing sits beside
 * it as an alias. It used to be the raw binding, shouted in the eyebrow style a
 * system's name is set in — so a node passed as `src` announced itself as
 * "SRC", which is neither a word nor anybody's label.
 *
 */
export function NodeCard({
  title,
  alias,
  signpost,
  node,
}: {
  title: string;
  /** The name this goes by in the script, where showing it connects two places
   *  on the board (an argument and the parameter it fills). */
  alias?: string;
  /** What this box IS, when it is a STEP rather than a call's argument: a step
   *  on the spine is signposted like every other (see {@link StepCard}), where
   *  an argument is already introduced by the sentence above it. */
  signpost?: { label: string; icon: React.ReactNode };
  node: StoryNode;
}) {
  return (
    <div
      {...readable(`w-full min-w-0 ${NODE_MAX} border border-dashed border-gray-300 bg-white px-3.5 py-3 ${BOX} ${LIFT}`)}
    >
      {signpost && (
        <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 text-gray-500">
          <span className="shrink-0">{signpost.icon}</span>
          <span className="min-w-0 text-[11px] font-medium uppercase tracking-[0.06em] [overflow-wrap:anywhere]">
            {signpost.label}
          </span>
          {alias !== undefined && <AliasChip name={alias} />}
        </div>
      )}
      <div className="min-w-0 text-[12.5px] leading-snug text-gray-700 [overflow-wrap:anywhere]">
        {title}
        {signpost === undefined && alias !== undefined && <AliasChip name={alias} />}
      </div>
      <FieldChips fields={node.fields} />
      {node.children.map((child, index) => (
        <div key={index} className="mt-2 space-y-2">
          {child.nodes.map((nested, i) => (
            <NodeCard key={i} title={`each ${child.name}`} node={nested} />
          ))}
        </div>
      ))}
      {isEmptyNode(node) && (
        <p className="mt-1.5 text-[11.5px] text-gray-400">Nothing in it.</p>
      )}
    </div>
  );
}

function isEmptyNode(node: StoryNode): boolean {
  return Object.keys(node.fields).length === 0 && node.children.length === 0;
}

/** What a name stands for, said as a person would say it. */
export function endpointName(
  endpoint: StoryEndpoint,
  records: Map<string, StoryViewRecord>,
): string {
  if (endpoint.kind === "record") {
    const record = records.get(endpoint.id);
    return record?.label ?? record?.binding ?? "it";
  }
  if (endpoint.kind === "trigger") return "what came in";
  return endpoint.ref.name;
}

/**
 * Card annotations, by record id.
 *
 * Only the DOWNSTREAM end is annotated, and only for the edge a record was
 * created along: saying it on both cards tells one fact twice, and a `link`
 * step is already a node of its own — annotating its edge as well would draw
 * the same connection in two places.
 */
export function relationsOf(input: {
  edges: StoryEdge[];
  records: Map<string, StoryViewRecord>;
}): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const edge of input.edges) {
    if (edge.kind !== "parent") continue;
    if (edge.from.kind !== "record" || edge.to.kind !== "record") continue;
    const parent = endpointName(edge.from, input.records);
    const line =
      parent === edge.edge
        ? `Linked to ${parent}`
        : `Linked to ${parent} as ${edge.edge}`;
    const existing = found.get(edge.to.id);
    if (existing) existing.push(line);
    else found.set(edge.to.id, [line]);
  }
  return found;
}
