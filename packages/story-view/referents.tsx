"use client";

import { createContext, useContext } from "react";
import type { Chip, ChipPart, StoryReference, StoryShapeNode, Step, StoryNode } from 'legacy-lang';
import type { StoryView, StoryViewRecord } from "./view";

/**
 * What a name in the script REFERS TO, said the way a person would say it.
 *
 * `m`, `co`, `c.name` mean nothing to a reader — they are the author's private
 * shorthand. Every reference arrives here carrying what the checker knew it
 * stood for, and the only thing this file adds is the connective tissue: "the",
 * "'s", "it just created". Every NOUN comes from a label the owning system
 * declared, or from a word the author wrote themselves.
 *
 * Two honesty rules run through it.
 *
 *   NOTHING RESOLVED ⇒ NOTHING CLAIMED. A reference with no origin, or one
 *   whose type nobody named, is shown exactly as it was written. A phrase
 *   nobody could check is worse than the shorthand.
 *
 *   A PHRASE THAT FITS TWO THINGS NAMES NEITHER. Two bindings of the same kind
 *   against the same type compose the same sentence, so the projection flags
 *   the collision and the name goes back on — in parentheses, once.
 *
 */

interface ReferentData {
  records: Map<string, StoryViewRecord>;
  types: StoryView["types"];
  /** Every node the file declares, by the address the type system knows it at —
   *  the root and each of its children. */
  shapes: Map<string, StoryShapeNode>;
  /** Names the page ends up SHOWING raw somewhere. */
  leaked: Set<string>;
}

const Referents = createContext<ReferentData>({
  records: new Map(),
  types: [],
  shapes: new Map(),
  leaked: new Set(),
});

export function ReferentsProvider({
  view,
  children,
}: {
  view: StoryView;
  children: React.ReactNode;
}) {
  return (
    <Referents.Provider
      value={{
        records: new Map(view.records.map((record) => [record.id, record])),
        types: view.types,
        shapes: shapesByPosition(view.shapes),
        leaked: leakedNames(view),
      }}
    >
      {children}
    </Referents.Provider>
  );
}

export function useRecords(): Map<string, StoryViewRecord> {
  return useContext(Referents).records;
}

/** The declaration a type points at, when the type is one the FILE declares. */
export function useShape(target: StoryTargetRef | undefined): StoryShapeNode | undefined {
  const { shapes } = useContext(Referents);
  if (target?.recordType === undefined || target.adapterType !== undefined) return undefined;
  return shapes.get(target.recordType);
}

/** What a type is CALLED, and whose it is. Both come from the join; a type
 *  nothing resolved answers with nothing rather than with its address. */
export function useTypeName(
  target: StoryTargetRef | undefined,
): StoryView["types"][number] | undefined {
  const { types } = useContext(Referents);
  if (target?.recordType === undefined) return undefined;
  return types.find(
    (type) =>
      type.recordType === target.recordType
      && (type.adapterType ?? undefined) === target.adapterType,
  );
}

type StoryTargetRef = { adapterType?: string; recordType?: string };

function shapesByPosition(shapes: StoryShapeNode[]): Map<string, StoryShapeNode> {
  const found = new Map<string, StoryShapeNode>();
  const walk = (node: StoryShapeNode): void => {
    found.set(node.position, node);
    for (const child of node.children) walk(child);
  };
  for (const shape of shapes) walk(shape);
  return found;
}

/**
 * The binding's own name, shown at the place the binding is INTRODUCED — "For
 * each person `p`".
 *
 * Only where it earns its place. Some of the script cannot be said in words at
 * all (a conditional expression, a function call), so it is shown as written,
 * and a reader who meets `p` there has nowhere to look it up. An alias at the
 * introduction site is that anchor. Stamping one on every card would put the
 * shorthand back on a page whose whole point is not needing it.
 *
 */
export function Alias({ name }: { name: string | undefined }) {
  const { leaked } = useContext(Referents);
  if (name === undefined || !leaked.has(name)) return null;
  return <AliasChip name={name} />;
}

/**
 * The same chip, shown because the PLACE calls for it rather than because the
 * name leaked: a call's argument and the parameter it fills are the same word,
 * and showing it on both sides is what ties the two columns together.
 */
export function AliasChip({ name }: { name: string }) {
  return (
    <span
      title="The name this goes by in the script"
      // `normal-case`: an eyebrow is set in capitals, and the script's own
      // spelling of a name is not the page's to shout.
      className="ml-1 rounded-md border border-gray-200 bg-gray-50 px-1 py-[1px] align-middle font-mono text-[10px] normal-case text-gray-400"
    >
      {name}
    </span>
  );
}

/**
 * Every name the page shows RAW: inside a piece it could not say in words, in
 * a reference nothing resolved, and beside a phrase that turned out to fit two
 * things. Computed from the story's own structure — never by reading text.
 */
function leakedNames(view: StoryView): Set<string> {
  const leaked = new Set<string>();

  const parts = (list: ChipPart[]): void => {
    for (const part of list) {
      switch (part.kind) {
        case "expression":
          for (const ref of part.refs) leaked.add(ref.name);
          break;
        case "reference":
          // Nothing resolved, so the source stands; or the phrase fitted two
          // things, so the name goes back beside it. Either way it is on screen.
          if (part.reference.origin === undefined && part.reference.path === undefined) {
            leaked.add(part.reference.root.name);
          }
          if (part.reference.ambiguous) leaked.add(part.reference.root.name);
          break;
        case "test":
          parts(part.subject);
          parts(part.against);
          break;
        case "group":
          for (const of of part.of) parts(of);
          break;
        case "not":
          parts(part.of);
          break;
        // A fold over a walk reads as a sentence built from the walk's own
        // landings. With no hops there is no sentence, so the path is shown as
        // written — and the name it starts from is then on screen.
        case "walk":
          if (part.traversal.hops.length === 0 && part.traversal.root) {
            leaked.add(part.traversal.root.name);
          }
          // A walk that starts at an EXPRESSION shows that expression as
          // written, hops or no hops — so every name it reads is on screen.
          for (const ref of part.traversal.rootExpression?.refs ?? []) {
            leaked.add(ref.name);
          }
          break;
        case "text":
          break;
      }
    }
  };

  const chip = (c: Chip): void => {
    // A chip with nothing to split shows its whole source, so every name in it
    // is on screen.
    if (!c.parts.some((part) => part.kind !== "text")) {
      for (const ref of c.refs) leaked.add(ref.name);
      return;
    }
    parts(c.parts);
  };

  const node = (n: StoryNode): void => {
    for (const c of Object.values(n.fields)) chip(c);
    for (const child of n.children) for (const nested of child.nodes) node(nested);
  };

  for (const record of view.records) {
    for (const c of Object.values(record.fields)) chip(c);
    // `Matched on \`Name\`` prints its chips as source, always.
    for (const c of record.uniqueBy) for (const ref of c.refs) leaked.add(ref.name);
  }

  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      switch (step.kind) {
        case "movement":
        // A deferred action's own name is NOT leaked by its card: the card says
        // it in words, and the alias appears only if the name turns up raw
        // somewhere else — which, where its id is spliced into a payload the
        // author wrote out by hand, it does.
        case "callback":
          walk(step.steps);
          break;
        case "group":
          for (const hop of step.over.hops) {
            if (hop.filter?.kind === "expression") chip(hop.filter.chip);
            if (hop.filter?.kind === "comparisons") {
              for (const comparison of hop.filter.all) chip(comparison.value);
            }
          }
          walk(step.steps);
          break;
        case "branch":
          for (const arm of step.arms) {
            chip(arm.condition);
            walk(arm.steps);
          }
          if (step.otherwise) walk(step.otherwise.steps);
          break;
        case "race":
          for (const branch of step.branches) walk(branch.steps);
          break;
        case "extract":
          for (const c of step.from) chip(c);
          break;
        case "call":
          for (const arg of step.args) {
            if (arg.kind === "value") chip(arg.chip);
            if (arg.kind === "node") node(arg.node);
          }
          break;
        case "node":
          node(step.node);
          break;
        case "value":
          chip(step.value);
          break;
        case "error":
          chip(step.message);
          break;
        case "wait":
          if (step.wait.kind === "until" && step.wait.condition) chip(step.wait.condition);
          break;
        // These print a binding's name in their sentence outright.
        case "delete":
        case "refresh":
          leaked.add(step.subject.name);
          break;
        case "bind":
          // A collection op run bare (`MAP(...)` as a statement) binds
          // nothing anyone reads, so there is no name to leak.
          if (step.binding !== undefined) leaked.add(step.binding);
          break;
        case "write":
        case "match":
        case "link":
        case "unlink":
        case "ask":
          break;
      }
    }
  };
  walk(view.flow);

  return leaked;
}

/** One reference, as a phrase. The script's own spelling stays on hover. */
export function Referent({ reference }: { reference: StoryReference }) {
  const data = useContext(Referents);
  const phrase = phraseOf(reference, data);

  if (phrase === null) {
    return (
      <span
        title="Taken from something earlier in the run"
        className="mx-0.5 inline rounded-md border border-sky-200 bg-sky-50 px-1.5 py-[1px] align-middle font-mono text-[11px] leading-[18px] text-sky-700 [overflow-wrap:anywhere]"
      >
        {reference.source}
      </span>
    );
  }

  return (
    <span
      title={reference.source}
      className="mx-0.5 inline rounded-md border border-sky-200 bg-sky-50 px-1.5 py-[1px] align-middle text-[11.5px] text-sky-800 [overflow-wrap:anywhere]"
    >
      {phrase}
      {reference.ambiguous && (
        <span className="ml-1 font-mono text-[10.5px] text-sky-600">
          ({reference.root.name})
        </span>
      )}
    </span>
  );
}

/**
 * A bound name a SENTENCE has to say out loud — what a delete removes, what a
 * refresh re-reads. It reads as the phrase a reference to it would read as,
 * because it is the same thing being named; where this story never wrote it,
 * the script's own name stands, as it always does when nothing resolved.
 */
export function BoundName({ name }: { name: string }) {
  const { records } = useContext(Referents);
  const record = [...records.values()].find((r) => r.binding === name);
  if (!record) {
    return (
      <span title="The name this goes by in the script" className="font-mono text-[11px]">
        {name}
      </span>
    );
  }
  return <>{writtenPhrase(record)}</>;
}

/** A record this story wrote, handed on — named by what happened to it, the
 *  same way a reference to it is named. */
export function WrittenRecord({ id }: { id: string }) {
  const { records } = useContext(Referents);
  const record = records.get(id);
  return <>{record ? writtenPhrase(record) : "it"}</>;
}

function writtenPhrase(record: StoryViewRecord): string {
  return `the ${record.label ?? "record"} it just ${DONE[record.action]}`;
}

/** How a write reads once it has happened — the reader watched it above. */
const DONE: Record<StoryViewRecord["action"], string> = {
  create: "created",
  update: "updated",
  find: "found",
};

function phraseOf(reference: StoryReference, data: ReferentData): string | null {
  const { origin, field } = reference;

  // A WALK reads as the same sentence a for-each header reads as, from the same
  // hops and the same declared labels — "each Attendee's Name". Chaining the
  // hops keeps a longer walk honest ("each Meeting's Attendee's Name") instead
  // of quietly naming only where it ended up.
  if (reference.path !== undefined && reference.path.length > 0) {
    const labels = reference.path.map((hop) => hopLabel(data.types, hop));
    if (field !== undefined) return possessive(`each ${labels.join("’s ")}`, field);
    // A walk with nothing read off it IS the things it landed on — a set, not
    // one value — so the last name in the chain goes plural and the phrase
    // names the set. Where the set came out of an extraction the reader watched
    // that happen a moment ago, so a single hop says so; a longer walk keeps
    // its chain, which is the part that would otherwise be dropped.
    const landed = plural(labels[labels.length - 1] ?? "");
    const before = labels.slice(0, -1);
    if (before.length === 0) {
      return origin?.kind === "extracted"
        ? `the ${landed} it picked out`
        : `the ${landed}`;
    }
    return `each ${before.join("’s ")}’s ${landed}`;
  }

  if (origin === undefined) return null;

  switch (origin.kind) {
    case "event":
    case "landing": {
      const label = labelOf(data.types, origin.target);
      return label === null ? null : possessive(`the ${label}`, field);
    }

    // The reader watched this record get written a moment ago, so it is named
    // by what happened to it rather than by where it sits. A field off it reads
    // the other way round: "the Url of the …" keeps the clause at the end,
    // where a possessive would have buried it.
    case "record": {
      const record = data.records.get(origin.record);
      const subject = `the ${record?.label ?? "record"} it just ${
        DONE[record?.action ?? "create"]
      }`;
      return field === undefined ? subject : `the ${field} of ${subject}`;
    }

    // A named entity is the author's own noun. The synthetic root has no noun —
    // nobody declared one — so it is described by what was done instead.
    case "extracted": {
      if (origin.entity !== undefined) return possessive(`the ${origin.entity}`, field);
      return field === undefined ? "what it picked out" : `the ${field} it picked out`;
    }

    // "your answer's Answer" says one word twice. When the field IS the word
    // the phrase already used, the possessive adds nothing — a comparison, not
    // a rewrite: the field name is never taken apart.
    case "answer":
      return field === undefined || sameWord(field, "answer")
        ? "your answer"
        : `your answer’s ${field}`;

    case "call":
      return field === undefined
        ? `what ${origin.movement} came back with`
        : `the ${field} from ${origin.movement}`;

    // A deferred action belongs to no system, so nobody declared a word for it
    // and there is exactly one honest noun available: the one the author chose.
    // That is the same answer a named extraction entity gives, and it is the
    // reason two of them never read alike.
    case "callback":
      return possessive(`the ${origin.name} action`, field);
  }
}

/**
 * What the system calls what a hop reaches. Where it named nothing, the
 * relationship's own name is the closest thing to a name there is — the same
 * fallback a for-each header makes, and for the same reason.
 */
function hopLabel(
  types: StoryView["types"],
  hop: NonNullable<StoryReference["path"]>[number],
): string {
  return (hop.landing !== undefined ? labelOf(types, hop.landing) : null) ?? hop.edge;
}

function possessive(subject: string, field: string | undefined): string {
  return field === undefined ? subject : `${subject}’s ${field}`;
}

/**
 * More than one of the thing a name names — English morphology over a declared
 * noun, the same connective tissue as the possessive above. It never invents a
 * noun: the word going in is the system's or the author's, and the word coming
 * out is that word said of many.
 *
 * A name that is ALREADY plural is left alone. Some systems name an edge by
 * what it collects ("Companies"), and pluralising a plural is how a phrase
 * starts saying something nobody wrote.
 */
function plural(noun: string): string {
  const irregular = IRREGULAR[noun.toLowerCase()];
  if (irregular !== undefined) return matchCase(noun, irregular);
  if (/s$/i.test(noun)) return noun;
  if (/(?:sh|ch|x|z)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/** The replacement said the way the original was written — a system's TitleCase
 *  label and an author's own lowercase word both come back as themselves. */
function matchCase(original: string, replacement: string): string {
  const first = original.slice(0, 1);
  if (first !== first.toUpperCase()) return replacement;
  return replacement.slice(0, 1).toUpperCase() + replacement.slice(1);
}

/** The English nouns no rule reaches. Kept to the ones a CRM's own vocabulary
 *  actually uses — a longer list would be a dictionary, not connective tissue. */
const IRREGULAR: Record<string, string> = {
  person: "people",
  child: "children",
  man: "men",
  woman: "women",
};

function sameWord(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b;
}

/**
 * What the system calls the type a reference landed on. Matched on the two
 * declared strings the story carried — never on a key composed out of them.
 */
function labelOf(
  types: StoryView["types"],
  target: { adapterType?: string; recordType?: string },
): string | null {
  if (target.recordType === undefined) return null;
  const found = types.find(
    (type) =>
      type.recordType === target.recordType
      && (type.adapterType ?? undefined) === target.adapterType,
  );
  return found?.label ?? null;
}
