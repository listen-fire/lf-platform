"use client";

import { Fragment } from "react";
import type { Chip, ChipPart } from 'legacy-lang';

import { Referent } from "./referents";
import { TESTS } from "./tests";
import { WalkFold } from "./traversal";

/**
 * One authored value, inline.
 *
 * A value the author wrote is one of two things, and they read nothing alike.
 * A FIXED value ("Passed", 12) is code, and shows as code. A value assembled
 * out of references — a template, a bare name — is a SENTENCE, and shows as
 * one: the literal runs as plain words, the references as the things they refer
 * to. The split comes from the story, which split it at the AST; nothing here
 * scans a string for `${`.
 *
 * `unparsed` is shown as itself. An expression we could not read is not a
 * literal, and colouring it like one would be the page claiming a fact it does
 * not have.
 *
 * A value that is a STRING is drawn on ONE WELL, whatever it is made of. A
 * fixed string already was one — the quoted box on a write card is the look —
 * and a template is the same value written another way, so it gets the same
 * box: the literal runs and the references it splices in sit TOGETHER inside
 * it. Loose in the card they read as chips floating in a paragraph, with the
 * text between them ("… · from ", "Filed in <") looking like the card's own
 * words rather than like the author's.
 *
 */
export function ValueChip({
  chip,
  title,
  labelled = true,
}: {
  chip: Chip;
  title?: string;
  /** Whether the chip says what KIND of value it is ("AI"). False where the
   *  card around it already signposts that — a label said twice in one card is
   *  a stutter, not emphasis. */
  labelled?: boolean;
}) {
  const tone = TONES[chip.role];
  const composed = chip.parts.some((part) => part.kind !== "text");
  const prefix = labelled ? tone.prefix : undefined;

  if (isStringValue(chip)) {
    return (
      <span
        title={title ?? tone.title}
        className={`mx-0.5 inline-block min-w-0 max-w-full rounded-md border px-2 py-1 align-top text-[11.5px] leading-[19px] [overflow-wrap:anywhere] ${WELLS[chip.role]}`}
      >
        {prefix && (
          <span className="mr-1 align-middle text-[10px] font-medium uppercase tracking-wide opacity-70">
            {prefix}
          </span>
        )}
        <Parts parts={chip.parts} mono />
      </span>
    );
  }

  if (composed) {
    return (
      <span className="inline text-[11.5px] leading-[19px] text-gray-600 [overflow-wrap:anywhere]">
        {prefix && (
          <span className="mr-1 align-middle text-[10px] font-medium uppercase tracking-wide text-violet-500">
            {prefix}
          </span>
        )}
        <Parts parts={chip.parts} />
      </span>
    );
  }

  return (
    <span
      title={title ?? tone.title}
      className={`mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-md border px-1.5 py-[1px] align-middle font-mono text-[11px] leading-[18px] ${tone.className}`}
    >
      {prefix && (
        <span className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-wide opacity-70">
          {prefix}
        </span>
      )}
      {/* A chip's whole point is the expression the author wrote, so it WRAPS —
          cutting it off would hide the very thing it exists to show. Inside a
          narrow lane `min-w-0` lets it shrink, and `[overflow-wrap:anywhere]`
          lets an unbroken run of code (a long path, a URL) break rather than
          push the lane wider. */}
      <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {chip.source}
      </span>
    </span>
  );
}

/**
 * Whether this value IS a string — the one question the well turns on, and the
 * story already answered it. A template (`interpolation`) and an AI prompt
 * (`ai`) are values BUILT OUT OF TEXT; a bare reference is not, and neither is
 * a test, which is a question about values rather than one of them. Nothing
 * here reads the source: the role is the checker's own ruling on the shape of
 * the expression, and the parts are that shape.
 *
 * The parts are checked because a role travels up through whatever it is
 * wrapped in — `AI("urgent?") == true` is an `ai` chip whose parts are a TEST,
 * and welling that would draw a question as if it were a message.
 */
function isStringValue(chip: Chip): boolean {
  if (chip.role !== "interpolation" && chip.role !== "ai") return false;
  return chip.parts.every(
    (part) => part.kind === "text" || part.kind === "reference" || part.kind === "expression",
  );
}

/** The same colours the pill wears, laid out as a box. A fixed string and a
 *  template are one family — both are the author's own words — so they read
 *  alike; an AI prompt keeps the violet it is known by everywhere else. */
const WELLS: Partial<Record<Chip["role"], string>> = {
  interpolation: "border-gray-200 bg-gray-50 text-gray-600",
  ai: "border-violet-200 bg-violet-50 text-violet-900",
};

const TONES: Record<
  Chip["role"],
  { className: string; title: string; prefix?: string }
> = {
  literal: {
    className: "border-gray-200 bg-gray-50 text-gray-600",
    title: "A fixed value",
  },
  interpolation: {
    className: "border-primary-200 bg-primary-50 text-primary-700",
    title: "Filled in from what came through",
  },
  ai: {
    className: "border-violet-200 bg-violet-50 text-violet-700",
    title: "Worked out for you at the time",
    prefix: "AI",
  },
  reference: {
    className: "border-sky-200 bg-sky-50 text-sky-700",
    title: "Taken from something earlier in the run",
  },
  unparsed: {
    className: "border-amber-300 bg-amber-50 text-amber-800",
    title: "This value could not be read — the script has a problem here",
  },
};

/**
 * `name: <chip>` pairs, for a card's field list.
 *
 * Every field, always. The card used to show three and count the rest ("+2
 * more"), which is the same silence as a truncated chip: what was hidden was
 * exactly what somebody came to read.
 */
export function FieldChips({ fields }: { fields: Record<string, Chip> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {entries.map(([name, chip]) => (
        <div
          key={name}
          className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[11.5px]"
        >
          <span className="text-gray-400 [overflow-wrap:anywhere]">{name}</span>
          <ValueChip chip={chip} />
        </div>
      ))}
    </div>
  );
}

/**
 * A piece of script this page has no words for, shown exactly as it was
 * written. The last resort of every composed phrase on the canvas — a filter it
 * cannot flatten, a fold it has no word for — so it is one component rather
 * than one look copied around.
 */
export function RawExpression({ source }: { source: string }) {
  return (
    <span
      title="Worked out at the time"
      className="mx-0.5 inline rounded-md border border-gray-200 bg-gray-50 px-1.5 py-[1px] align-middle font-mono text-[11px] text-gray-600 [overflow-wrap:anywhere]"
    >
      {source}
    </span>
  );
}

/** The parts of one expression, in order. Inside a well the literal runs are
 *  set in the same face a fixed string is, which is what makes the author's own
 *  words look like the author's own words and not like the card's. */
function Parts({ parts, mono }: { parts: ChipPart[]; mono?: boolean }) {
  return (
    <>
      {parts.map((part, index) => (
        <Part key={index} part={part} mono={mono} />
      ))}
    </>
  );
}

function Part({ part, mono }: { part: ChipPart; mono?: boolean }) {
  switch (part.kind) {
    case "text":
      return (
        <span className={`whitespace-pre-wrap${mono ? " font-mono text-[11px]" : ""}`}>
          {part.text}
        </span>
      );

    case "reference":
      return <Referent reference={part.reference} />;

    // A piece with more in it than a reference is shown WHOLE, as the author
    // wrote it — a phrase would leave out the working.
    case "expression":
      return <RawExpression source={part.source} />;

    // A fold over a walk reads as the sentence the walk composes, with the
    // fold's own word in front of it.
    case "walk":
      return <WalkFold fn={part.fn} id={part.traversal.id} source={part.source} />;

    case "test": {
      const { verb, reads } = TESTS[part.operator];
      return (
        <>
          <Parts parts={part.subject} /> {verb}
          {reads && (
            <>
              {" "}
              <Parts parts={part.against} />
            </>
          )}
        </>
      );
    }

    case "group":
      return (
        <>
          {part.of.map((of, index) => (
            <Fragment key={index}>
              {index > 0 && ` ${part.joiner} `}
              <Parts parts={of} />
            </Fragment>
          ))}
        </>
      );

    case "not":
      return (
        <>
          not <Parts parts={part.of} />
        </>
      );
  }
}
