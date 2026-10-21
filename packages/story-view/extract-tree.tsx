"use client";

import type { Step } from 'legacy-lang';

import { BOX, LIFT } from "./canvas-style";
import { typeWord } from "./field-words";
import { readable } from "./pannable-surface";
import { NODE_MAX } from "./sizing";

/**
 * What an extraction is actually looking for — the WHOLE tree, not a summary.
 *
 * An extraction's shape is the most interesting thing about it: which things
 * are being found, what is being read off each one, and which of them hang off
 * which. A summary line ("looking for: company, person") threw away the two
 * facts a reader wants — the fields, and the nesting — so the tree is drawn as
 * a tree: one framed entity per node, its fields listed inside it, its own
 * entities nested within.
 *
 * Every word here except the connective tissue is the AUTHOR's: the entity
 * name, the field name, and the sentence they wrote to describe each. Nothing
 * is invented, and nothing is shortened.
 *
 */

type ExtractStep = Extract<Step, { kind: "extract" }>;
export type ExtractNode = NonNullable<ExtractStep["tree"]>;
type ExtractField = ExtractNode["fields"][number];

export function ExtractTree({ tree }: { tree: ExtractNode }) {
  // The root of the tree is synthetic — the author never named or described it,
  // so it is drawn as the contents of the extraction rather than as an entity.
  return (
    // The tree caps where every node does: its own descriptions are sentences,
    // and uncapped they would make the extraction — and so the column — as wide
    // as the longest thing the author wrote about a field.
    <div className={`w-full min-w-0 ${NODE_MAX} space-y-2`}>
      <Fields fields={tree.fields} />
      {tree.children.map((child, index) => (
        <Entity key={index} node={child} />
      ))}
      {isEmpty(tree) && <p {...readable("text-[11.5px] text-gray-400")}>Nothing yet.</p>}
    </div>
  );
}

function Entity({ node }: { node: ExtractNode }) {
  return (
    <div {...readable(`min-w-0 border border-gray-200 bg-white px-3 py-2 ${BOX} ${LIFT}`)}>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-gray-500 [overflow-wrap:anywhere]">
        {node.name}
      </div>
      {node.description !== undefined && (
        <p className="mt-0.5 text-[11.5px] leading-snug text-gray-500 [overflow-wrap:anywhere]">
          {node.description}
        </p>
      )}
      <div className="mt-1.5 space-y-2">
        <Fields fields={node.fields} />
        {node.children.map((child, index) => (
          <Entity key={index} node={child} />
        ))}
      </div>
    </div>
  );
}

function Fields({ fields }: { fields: ExtractField[] }) {
  if (fields.length === 0) return null;
  return (
    <div className="space-y-1">
      {fields.map((field, index) => (
        <div
          key={index}
          {...readable("flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[11.5px] leading-snug")}
        >
          <span className="font-medium text-gray-600 [overflow-wrap:anywhere]">
            {field.name}
          </span>
          {field.type !== undefined && (
            <span className={`border border-gray-200 bg-gray-50 px-1 py-[1px] text-[10px] text-gray-500 ${BOX}`}>
              {typeWord(field.type)}
            </span>
          )}
          <span className="min-w-0 text-gray-400 [overflow-wrap:anywhere]">
            {field.description}
          </span>
        </div>
      ))}
    </div>
  );
}

function isEmpty(tree: ExtractNode): boolean {
  return tree.fields.length === 0 && tree.children.length === 0;
}
