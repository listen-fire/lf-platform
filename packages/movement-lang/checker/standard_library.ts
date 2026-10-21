// The standard library as the language holds it: the Rust checker's built-in
// table (crates/movement-checker/src/types/stdlib.rs), each built-in's
// parameters, what it gives back and its one-line summary, read through the
// engine artifact's `standard_library` export. The one source for anything
// that lists built-ins (the handbook's language search); the platform's
// TypeScript checker keeps its own registry for its own checking.
//
// It loads with the engine artifact, which a browser never downloads.

import { callStandardLibrary } from '../wasm/loader';

/** What a parameter takes, as the table spells it. */
export const BUILTIN_PARAM_TYPES = [
  'scalar',
  'text',
  'number',
  'temporal',
  'file',
  'textOrList',
  'list',
  'any',
  'record',
  'options',
  'function',
  'type',
  'shape',
] as const;
export type BuiltinParamType = (typeof BUILTIN_PARAM_TYPES)[number];

export interface StandardBuiltinParam {
  name: string;
  type: BuiltinParamType;
  optional?: true;
  /** Takes every argument from here on. */
  rest?: true;
}

export interface StandardBuiltin {
  /** The canonical name (`JOIN`, `CURRENCY.FORMAT_FIGURE`); the spelling
   *  table (`surfaceTable`) gives the name an author writes. */
  name: string;
  params: readonly StandardBuiltinParam[];
  /** What a call gives back, as the checker describes a type (`list of
   *  text`, `text (or absent)`), or `derived`: it follows from the arguments. */
  returns: string;
  /** One line for listings. `RETIRED — …` for a built-in kept only so old
   *  automations still read. */
  summary: string;
}

let table: readonly StandardBuiltin[] | undefined;

/** Every built-in, in the table's order, read once from the WASM. */
export function standardLibraryTable(): readonly StandardBuiltin[] {
  if (table === undefined) {
    const { ok, json } = callStandardLibrary();
    if (!ok || !Array.isArray(json)) throw new Error(`standard_library: ${JSON.stringify(json)}`);
    table = json.map(builtinOf);
  }
  return table;
}

function builtinOf(value: unknown): StandardBuiltin {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.params) ||
    typeof value.returns !== 'string' ||
    typeof value.summary !== 'string'
  ) {
    throw new Error(`standard_library answered a built-in that is not one: ${JSON.stringify(value)}`);
  }
  return { name: value.name, params: value.params.map(paramOf), returns: value.returns, summary: value.summary };
}

function paramOf(value: unknown): StandardBuiltinParam {
  const type = isRecord(value) ? BUILTIN_PARAM_TYPES.find((t) => t === value.type) : undefined;
  if (!isRecord(value) || typeof value.name !== 'string' || type === undefined) {
    throw new Error(`standard_library answered a parameter that is not one: ${JSON.stringify(value)}`);
  }
  return {
    name: value.name,
    type,
    ...(value.optional === true ? { optional: true as const } : {}),
    ...(value.rest === true ? { rest: true as const } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
