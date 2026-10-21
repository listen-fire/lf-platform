"use client";

import type { StoryArg, StoryParam, StoryShapeNode } from 'legacy-lang';

import { BrandMark } from "./brand-mark";
import { NodeCard } from "./cards";
import { BOX, LIFT } from "./canvas-style";
import { typeWord } from "./field-words";
import { readable } from "./pannable-surface";
import { AliasChip, useShape, useTypeName } from "./referents";
import { NODE_MAX } from "./sizing";

/**
 * What a movement TAKES, as a card.
 *
 * A shared movement is the one thing on the board that starts with a hole in
 * it: something hands it its subject, and until this card existed the reader
 * met the parameter for the first time halfway down the column, as a name in a
 * sentence. So the column opens by saying what it is given.
 *
 * Every word of it is somebody's declaration. A node the FILE declares carries
 * the author's own field names and their annotated types; a position in a
 * system carries that system's label and mark. A parameter nothing resolved
 * says only its name — an invented shape would be the one thing worse than the
 * hole.
 *
 */
export function ParamCard({ param }: { param: StoryParam }) {
  const shape = useShape(param.target);
  const type = useTypeName(param.target);

  return (
    <div
      {...readable(`w-full min-w-0 ${NODE_MAX} border border-dashed border-gray-300 bg-white px-3.5 py-3 ${BOX} ${LIFT}`)}
    >
      {type?.system && (
        <div className="flex min-w-0 items-center gap-2 text-gray-500">
          <BrandMark system={type.system} />
          <span className="min-w-0 text-[11px] font-medium uppercase tracking-[0.06em] [overflow-wrap:anywhere]">
            {type.system.label}
          </span>
        </div>
      )}
      <p className="mt-1 text-[12.5px] leading-snug text-gray-700 [overflow-wrap:anywhere]">
        {type?.label !== undefined && type.label !== null ? (
          <>{withArticle(type.label)}</>
        ) : (
          <span className="text-gray-400">Something the caller hands it</span>
        )}
        <AliasChip name={param.name} />
      </p>
      {shape && <ShapeFields node={shape} />}
    </div>
  );
}

/**
 * The declared node's own fields, and the nodes hanging off it. The same
 * reading a node card gives — name, then what goes in it — except that what
 * goes in it here is a TYPE rather than a value, because nothing has been
 * handed over yet.
 */
function ShapeFields({ node }: { node: StoryShapeNode }) {
  return (
    <>
      {node.fields.length > 0 && (
        <div className="mt-2 space-y-1">
          {node.fields.map((field) => (
            <div
              key={field.name}
              className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[11.5px]"
            >
              <span className="font-medium text-gray-600 [overflow-wrap:anywhere]">
                {field.name}
              </span>
              {/* The same pill an extraction's fields wear: a field's name and
                  its type sit side by side, and only one of them is a noun the
                  author chose. */}
              {field.type !== undefined && (
                <span className={`border border-gray-200 bg-gray-50 px-1 py-[1px] text-[10px] text-gray-500 ${BOX}`}>
                  {typeWord(field.type)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {node.children.map((child) => (
        <div
          key={child.position}
          className={`mt-2 border border-dashed border-gray-200 bg-gray-50/60 px-2.5 py-2 ${BOX}`}
        >
          <div className="text-[11px] text-gray-500 [overflow-wrap:anywhere]">
            each {child.name}
          </div>
          <ShapeFields node={child} />
        </div>
      ))}
      {isEmpty(node) && (
        <p className="mt-1.5 text-[11.5px] text-gray-400">Nothing in it.</p>
      )}
    </>
  );
}

function isEmpty(node: StoryShapeNode): boolean {
  return node.fields.length === 0 && node.children.length === 0;
}

/**
 * A node assembled at a call site, titled by the parameter it FILLS — so the
 * card under "Runs toAttio with:" says the same noun the helper's own column
 * says it takes, and the two read as one thing seen from two ends.
 *
 * The callee's parameter is a fact about the callee's declaration, so it is
 * looked up rather than guessed; a call into something this file doesn't
 * declare has no parameter to name and says what the step does instead.
 */
export function ArgumentCard({
  arg,
  param,
}: {
  arg: Extract<StoryArg, { kind: "node" }>;
  param: StoryParam | undefined;
}) {
  const type = useTypeName(param?.target);
  const label = type?.label;
  return (
    <NodeCard
      title={label !== undefined && label !== null ? withArticle(label) : "What it sends"}
      alias={param?.name ?? arg.name}
      node={arg.node}
    />
  );
}

/** "a Company", "an Email" — connective tissue over a word somebody else
 *  declared, never a word of its own. */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "An" : "A"} ${noun}`;
}
