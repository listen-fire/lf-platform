// Function signatures for the formula / source-traversal DSL, plus the
// caret-position detector that drives the editor's argument hints. The
// signature set mirrors the functions the grammar's parser recognises
// (movement-lang/expression/formula `parseFunctionCall`); the prose is
// authoring help. Pure — no React — so it unit-tests in isolation.

export interface FnParam {
  name: string;
  description: string;
}

export interface FnSignature {
  name: string;
  summary: string;
  params: FnParam[];
  /** A trailing variadic param accepts any number of further arguments. */
  variadic?: boolean;
}

export interface SignatureHint {
  name: string;
  summary: string;
  params: FnParam[];
  variadic: boolean;
  /** 0-based index of the argument the caret is in (raw top-level comma
   *  count). The renderer highlights `params[min(activeParam, last)]` so a
   *  trailing variadic param stays lit for every extra argument. */
  activeParam: number;
}

const SIGNATURES: Record<string, FnSignature> = {
  AI: {
    name: "AI",
    summary: "Run a language model and return its answer.",
    params: [
      {
        name: "prompt",
        description:
          "The instruction — a static string or an expression to feed the model.",
      },
    ],
  },
  CONCAT: {
    name: "CONCAT",
    summary: "Join values into one string.",
    params: [
      {
        name: "…parts",
        description: "Values joined left to right; null becomes empty text.",
      },
    ],
    variadic: true,
  },
  COALESCE: {
    name: "COALESCE",
    summary: "First value that isn't empty.",
    params: [
      {
        name: "…values",
        description: "Returns the first argument that is not null / empty.",
      },
    ],
    variadic: true,
  },
  EXTRACT_VALUE: {
    name: "EXTRACT_VALUE",
    summary: "Pull a described value out of the extraction context.",
    params: [
      {
        name: "description",
        description:
          "What to extract, as a string. Only valid inside an #extract.",
      },
    ],
  },
  UPPER: {
    name: "UPPER",
    summary: "Uppercase text.",
    params: [{ name: "text", description: "The text to uppercase." }],
  },
  LOWER: {
    name: "LOWER",
    summary: "Lowercase text.",
    params: [{ name: "text", description: "The text to lowercase." }],
  },
  TRIM: {
    name: "TRIM",
    summary: "Remove surrounding whitespace.",
    params: [{ name: "text", description: "The text to trim." }],
  },
  TOSTRING: {
    name: "TOSTRING",
    summary: "Convert a value to text.",
    params: [{ name: "value", description: "The value to stringify." }],
  },
  TONUMBER: {
    name: "TONUMBER",
    summary: "Parse a value as a number.",
    params: [{ name: "value", description: "The value to parse." }],
  },
  ISNULL: {
    name: "ISNULL",
    summary: "True when the value is null / empty.",
    params: [{ name: "value", description: "The value to test." }],
  },
  JOIN: {
    name: "JOIN",
    summary: "Join many values into one string with a separator.",
    params: [
      { name: "values", description: "The collection to join." },
      { name: "separator", description: "Text placed between each value." },
    ],
  },
  ONLY: {
    name: "ONLY",
    summary:
      "The one that matched — empty when nothing did, and the run fails when more than one does.",
    params: [{ name: "values", description: "The collection." }],
  },
  FIRST: {
    name: "FIRST",
    summary: "First value in a collection (needs one that has an order).",
    params: [{ name: "values", description: "The collection." }],
  },
  LAST: {
    name: "LAST",
    summary: "Last value in a collection (needs one that has an order).",
    params: [{ name: "values", description: "The collection." }],
  },
  COUNT: {
    name: "COUNT",
    summary: "Number of values in a collection.",
    params: [{ name: "values", description: "The collection." }],
  },
  SUM: {
    name: "SUM",
    summary: "Sum of a numeric collection.",
    params: [{ name: "values", description: "The numeric collection." }],
  },
  AVG: {
    name: "AVG",
    summary: "Average of a numeric collection.",
    params: [{ name: "values", description: "The numeric collection." }],
  },
  MIN: {
    name: "MIN",
    summary: "Smallest value in a collection.",
    params: [{ name: "values", description: "The collection." }],
  },
  MAX: {
    name: "MAX",
    summary: "Largest value in a collection.",
    params: [{ name: "values", description: "The collection." }],
  },
  COLLECT: {
    name: "COLLECT",
    summary: "Gather values into a list.",
    params: [{ name: "values", description: "The values to collect." }],
  },
  MAP: {
    name: "MAP",
    summary: "Every member of a list, through a function.",
    params: [
      { name: "values", description: "The list to read." },
      { name: "f", description: "A function taking one member — `(m) => { return … }`." },
    ],
  },
  FILTER: {
    name: "FILTER",
    summary: "The members of a list a function answers TRUE for.",
    params: [
      { name: "values", description: "The list to read." },
      { name: "f", description: "A function taking one member, answering TRUE or FALSE." },
    ],
  },
  REDUCE: {
    name: "REDUCE",
    summary: "Carry a value forward across a list, member by member (needs one that has an order).",
    params: [
      { name: "values", description: "The list to read." },
      { name: "start", description: "The value to begin with." },
      { name: "f", description: "A function taking the value so far and the next member." },
    ],
  },
  GROUPBY: {
    name: "GROUPBY",
    summary: "File each member under a text key — a set of lists, looked up by name.",
    params: [
      { name: "values", description: "The list to read." },
      { name: "key", description: "A function answering the key for one member." },
    ],
  },
  KEYBY: {
    name: "KEYBY",
    summary: "File each member under a text key that names exactly one of them.",
    params: [
      { name: "values", description: "The list to read." },
      { name: "key", description: "A function answering the key for one member." },
    ],
  },
  MEMBERS: {
    name: "MEMBERS",
    summary: "A closed type's values, in the order they were declared.",
    params: [{ name: "type", description: "The type, in angle brackets — `<Thesis>`." }],
  },
  LLM_AGG: {
    name: "LLM_AGG",
    summary: "Aggregate a collection with a language model.",
    params: [{ name: "values", description: "The collection to summarise." }],
  },
  KG_EXISTS: {
    name: "KG_EXISTS",
    summary: "True when a knowledge-graph query matches.",
    params: [
      { name: "query", description: "The query string." },
      { name: "…params", description: "Values bound into the query." },
    ],
    variadic: true,
  },
  KG_VALUE: {
    name: "KG_VALUE",
    summary: "Value returned by a knowledge-graph query.",
    params: [
      { name: "query", description: "The query string." },
      { name: "…params", description: "Values bound into the query." },
    ],
    variadic: true,
  },
};

const isIdentChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

interface Frame {
  name: string | null;
  argIndex: number;
}

/**
 * Walk the text up to the caret, string-aware, returning the open bracket
 * frames at the caret (outermost-first). Each `(` is a call frame when an
 * identifier precedes it, else a grouping frame; `[` / `{` are non-call
 * frames. A frame's `argIndex` is its top-level comma count.
 */
function callFramesAtCaret(text: string, caret: number): Frame[] {
  const stack: Frame[] = [];
  let i = 0;
  while (i < caret) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < caret && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      let k = i - 1;
      while (k >= 0 && isSpace(text[k])) k--;
      const end = k;
      while (k >= 0 && isIdentChar(text[k])) k--;
      const name = end > k ? text.slice(k + 1, end + 1) : null;
      stack.push({ name, argIndex: 0 });
      i++;
      continue;
    }
    if (ch === "[" || ch === "{") {
      stack.push({ name: null, argIndex: 0 });
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      stack.pop();
      i++;
      continue;
    }
    if (ch === ",") {
      if (stack.length) stack[stack.length - 1].argIndex++;
      i++;
      continue;
    }
    i++;
  }
  return stack;
}

/** A map of caller-supplied extra signatures (e.g. a target field's adapter
 *  functions like SLACK_MESSAGE), keyed by UPPERCASED name. Built-ins always
 *  win the lookup (P8) so a field can't shadow `TRIM`. */
export type ExtraSignatures = Record<string, FnSignature>;

function lookupSignature(name: string, extra?: ExtraSignatures): FnSignature | undefined {
  const key = name.toUpperCase();
  return SIGNATURES[key] ?? extra?.[key];
}

/**
 * Build the extra-signature map the hint pipeline merges in, from the field
 * functions advertised on the field being mapped. Keyed by uppercased name to
 * match the lookup.
 */
export function signaturesFromFieldFunctions(
  fns: readonly {
    name: string;
    summary?: string;
    params?: readonly { name: string; doc?: string; variadic?: boolean }[];
  }[],
): ExtraSignatures {
  const out: ExtraSignatures = {};
  for (const fn of fns) {
    out[fn.name.toUpperCase()] = {
      name: fn.name,
      summary: fn.summary ?? "",
      params: (fn.params ?? []).map((p) => ({ name: p.name, description: p.doc ?? "" })),
      variadic: fn.params?.some((p) => p.variadic) ?? false,
    };
  }
  return out;
}

function frameToHint(frame: Frame, extra?: ExtraSignatures): SignatureHint | null {
  if (!frame.name) return null;
  const sig = lookupSignature(frame.name, extra);
  if (!sig) return null;
  return {
    name: sig.name,
    summary: sig.summary,
    params: sig.params,
    variadic: !!sig.variadic,
    activeParam: frame.argIndex,
  };
}

/**
 * Every enclosing known function call at the caret, innermost-first. Used
 * to build the inside-out hint stack.
 */
export function functionStackAtCaret(
  text: string,
  caret: number,
  extra?: ExtraSignatures,
): SignatureHint[] {
  const frames = callFramesAtCaret(text, caret);
  const hints: SignatureHint[] = [];
  for (let s = frames.length - 1; s >= 0; s--) {
    const hint = frameToHint(frames[s], extra);
    if (hint) hints.push(hint);
  }
  return hints;
}

/**
 * The innermost known function-call signature hint for the caret, or null.
 */
export function signatureHintAtCaret(
  text: string,
  caret: number,
  extra?: ExtraSignatures,
): SignatureHint | null {
  return functionStackAtCaret(text, caret, extra)[0] ?? null;
}

/** A function name the caret sits ON (an identifier immediately followed by
 *  `(`) that resolves to a known signature — the leaf when the caret is on
 *  the name itself rather than inside the parens. */
export function functionNameHintAt(
  text: string,
  caret: number,
  extra?: ExtraSignatures,
): SignatureHint | null {
  let start = caret;
  let end = caret;
  while (start > 0 && isIdentChar(text[start - 1])) start--;
  while (end < text.length && isIdentChar(text[end])) end++;
  if (start === end) return null;
  let j = end;
  while (j < text.length && isSpace(text[j])) j++;
  if (text[j] !== "(") return null;
  const sig = lookupSignature(text.slice(start, end), extra);
  if (!sig) return null;
  return {
    name: sig.name,
    summary: sig.summary,
    params: sig.params,
    variadic: !!sig.variadic,
    activeParam: -1,
  };
}
