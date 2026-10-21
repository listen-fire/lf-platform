// Injectable catalog interface for the movement checker (M2).
//
// The movement-lang package stays pure: it never reads adapter manifests,
// credential stores, or plugin registries itself. The host (apps/api)
// implements `Catalog` from its real sources — adapter manifests
// (listEntryPoints / describeTypes), the workspace credential store, the
// transform-plugin registry — and injects it into `checkProgram`.
//
// M2a needed only the file-boundary facts (4_type_system.md "What the
// checker knows", check 1): which adapters / credentials / plugins exist,
// which named arguments a construction call accepts, which of those is the
// credential, and which adapter each credential authenticates. M2b adds the
// per-instance schema surface (`InstanceSchema`) that the typed checks —
// writes, linked writes, traversal validity, narrowing, call fit — resolve
// against. A host that cannot produce a schema returns `undefined` from
// `instantiate`; every schema-typed check stays silent for that instance.

// The part of this file the language package keeps; re-exported first so a cycle through this module sees it.
export { type ConnectAction } from 'movement-lang/catalog/types';
export { type SchemaFieldType } from 'movement-lang/catalog/types';
export { credentialArgOf, entryPositionKeyOf, pluginKey, pluginProgramNameOf, findPlugin, refinementKey, unionKey, unionDisplay, unionVariants, modelsMember, mockCatalog, type ConstructionArg, type AdapterSpec, type CredentialSpec, type PluginSpec, type PluginFedArg, type PluginOutput, type EdgeSchema, type PositionSchema, type DiscriminatedWriteShape, type WriteUnionShape, type WritableRootSchema, type CollectionSchema, type InstanceSchema, type Catalog } from 'movement-lang/catalog/types';
import type {
  EdgeCapability,
  EdgeSequencing,
  Expression,
  FieldCapability,
} from 'movement-lang/expression/types';
import { neverAsAny } from 'movement-lang/never';
import { type LanguageVersion } from 'movement-lang/language_version';
import { before, since } from '../version_conditionals';
import type { CallArg, ExprSlot, Loc, NamedArg, PluginCall, Program, Span, TypeDeclaration } from 'movement-lang/parser/ast';
import { treeOfSlot } from '../expression/bridge';
import { slotTrees } from 'movement-lang/expression/slot_trees';
import { pluginName } from 'movement-lang/parser/surface';
import { isMapSpread, type At, type MapMember, type MExpr } from 'movement-lang/parser/expression/tree';
import type { DeclaredEffectRow } from './effects';
// A record is a value, so `FieldType` names the arrow plane's own type and
// spells it with the arrow plane's own words. That is a cycle with `typing.ts`
// and it is the honest one: neither plane is beneath the other, and there is
// one type universe rather than a copy of position types kept here. Nothing is
// read at module load, so the two initialise in either order.
import { describePosition, type PositionTypeRef } from './typing';
import { pluginProgramNameOf, type PluginSpec, type PluginOutput, type EdgeSchema, type PositionSchema, type InstanceSchema, type Catalog } from 'movement-lang/catalog/types';
import { type SchemaFieldType } from 'movement-lang/catalog/types';


// Every surface type is a checker type: the schema's union is `FieldType` less the record.
const _schemaTypeIsFieldType: SchemaFieldType extends FieldType ? true : never = true;
void _schemaTypeIsFieldType;


/**
 * The one UNIVERSAL listen-config key — valid on every listener regardless of
 * adapter, like `dry_run` is the universal construction arg. It is NOT a loop
 * detector: it's a declarative 2-WAY-SYNC semantic. When an author builds an
 * A↔B sync (a movement that both reads and writes the same system) they set
 * `suppress_self: true` to mean "ignore my own writes echoing back into this
 * system," so the sync doesn't self-trigger.
 *
 * DEFAULT OFF (absent / false). Off matters: a user legitimately wants to react
 * to Listen-Fire's own writes (Movement 1 writes a company to Attio → Movement 2
 * posts new Attio companies to Slack). A default-on suppression would nuke that.
 *
 * Boolean-literal only. Validated centrally in `checkListen` (so every adapter
 * accepts it without each declaring it), then carried into
 * the persisted trigger config; the dispatch boundary capability-gates it on
 * the adapter answering "did WE author this change?". An adapter that can't
 * answer makes it a clearly-logged no-op.
 */
export const SUPPRESS_SELF_KEY = 'suppress_self';

/**
 * The event node's change-kind field — the ONE protocol name (like
 * `suppress_self` or the `events:` listen key) for "which kind of event this
 * occurrence is". An adapter with a change-kind axis declares an ordinary
 * enum field of this name on its event node, its options exactly the
 * listen's `events:` vocabulary; a listen's selection then pins it in the
 * derived event address, and a signature narrows with
 * `` WHERE `action` == "record.created" ``. Adapters with no such axis
 * (cron's tick, a messaging Message Received) simply declare no such field.
 *
 */
export const EVENT_ACTION_FIELD = 'action';

/** The `events:` value that means "the record no longer exists" — the pin
 *  under which `requiresLiveRecord` edges are dropped from a narrowed event
 *  position (the one real behaviour the retired delete VARIANT carried,
 *  keyed on the pin rather than on a synthesized name). The `record.*`
 *  vocabulary is deliberately uniform across adapters (attio, airtable). */
export const RECORD_DELETED_ACTION = 'record.deleted';

/** The packages that serve a bare plugin name when more than one does. */
export function ambiguousPluginPackages(catalog: Pick<Catalog, 'plugin' | 'pluginNames'>, name: string): string[] {
  const packages: string[] = [];
  for (const key of catalog.pluginNames?.() ?? []) {
    const spec = catalog.plugin(key);
    if (spec !== undefined && pluginProgramNameOf(key, spec) === name && spec.package !== undefined) packages.push(spec.package);
  }
  return packages.length > 1 ? packages : [];
}

/** One plugin of a package: the name it is called by after the package's
 *  local name and a dot, and the catalog's key it invokes. */
export interface PackageMember {
  name: string;
  key: string;
}

/** The plugins whose spec declares `tag` as its package, in catalog order;
 *  none when no spec does, which is how a package import is told from an
 *  import of one plugin. */
export function packageMembers(catalog: Pick<Catalog, 'plugin' | 'pluginNames'>, tag: string): PackageMember[] {
  return (catalog.pluginNames?.() ?? [])
    .filter(key => catalog.plugin(key)?.package === tag)
    .map(key => ({ name: pluginName(pluginProgramNameOf(key, catalog.plugin(key)!)), key }));
}

/** The local name an unnamed package import's fix suggests: the tag's last
 *  word in camelCase (`@lf/web-tools` → `webTools`), or `pkg`. The Rust twin
 *  is `local_name_for_tag` (crates/movement-parser/src/stmt.rs). */
export function packageLocalName(tag: string): string {
  const last = tag.split(/[/@.:]/).filter(w => w !== '').pop() ?? '';
  let out = '';
  let upper = false;
  for (const c of last) {
    if (/^[A-Za-z0-9]$/.test(c)) {
      if (out === '' && /^[0-9]$/.test(c)) continue;
      out += upper && out !== '' ? c.toUpperCase() : c;
      upper = false;
    } else {
      upper = true;
    }
  }
  return out === '' ? 'pkg' : out;
}

/** The package a bare name stands for when the program imported none: the tag
 *  whose default local name is `name` (`@lf/pdf` → `pdf`). The Rust twin is
 *  `package_called` (crates/movement-parser/src/catalog/packages.rs). */
export function packageCalled(catalog: Pick<Catalog, 'plugin' | 'pluginNames'>, name: string): string | undefined {
  for (const key of catalog.pluginNames?.() ?? []) {
    const tag = catalog.plugin(key)?.package;
    if (tag !== undefined && packageLocalName(tag) === name) return tag;
  }
  return undefined;
}

/** The local name a package's member is bound to: `web.fetchUrl`. */
export function memberLocal(packageLocal: string, member: string): string {
  return `${packageLocal}.${member}`;
}

/** The program with each package import read as the imports of its members
 *  (`` `@lf/web` as web `` → `fetch_url as web.fetchUrl`, …), which is what an
 *  engine binds. An import that names no package is left as written. The
 *  checker does not read this: it binds the same names itself, keeping the
 *  package to name in a diagnostic. */
export function expandPackageImports(
  program: Program,
  catalog: Pick<Catalog, 'plugin' | 'pluginNames'>,
  languageVersion: LanguageVersion,
): Program {
  if (!since(languageVersion, 5)) return program;
  return {
    ...program,
    statements: program.statements.map(statement => {
      if (statement.kind !== 'import' || statement.source.kind !== 'builtin' || statement.source.namespace !== 'plugins') {
        return statement;
      }
      return {
        ...statement,
        names: statement.names.flatMap(imported => {
          const members = packageMembers(catalog, imported.name);
          if (members.length === 0) return [imported];
          const local = imported.alias ?? imported.name;
          return members.map(m => ({ name: m.key, alias: memberLocal(local, m.name) }));
        }),
      };
    }),
  };
}

/** The parameter a plain call hands a plugin fed only by an extraction (from
 *  language version 5): the record it runs on, which a `through [ … ]` stage
 *  fed it implicitly. */
export const EXTRACTED_RECORD_PARAM = 'record';

/**
 * A plugin as a plain call sees it under `languageVersion`. From version 5 a
 * plugin is a function, so one fed only by an extraction is no longer a
 * stage: what the stage fed it implicitly — the record it enriched — becomes
 * its one required input, written by position like any fed argument and
 * taking structured data. Versions 1–4 read the spec as it is, and refuse the
 * call. The Rust twin is `PluginSpec::under` (crates/movement-parser/src/catalog/plugin_args.rs).
 */
export function pluginSpecUnder(spec: PluginSpec, languageVersion: LanguageVersion): PluginSpec {
  if (spec.fedByExtraction !== true || before(languageVersion, 5)) return spec;
  const { fedByExtraction: _fed, ...callable } = spec;
  return {
    ...callable,
    fedArgs: [{ name: EXTRACTED_RECORD_PARAM, required: true }, ...(spec.fedArgs ?? [])],
    argTypes: { ...spec.argTypes, [EXTRACTED_RECORD_PARAM]: 'json' },
  };
}

/** Where a plugin is called: a plain call writes the arguments a stage is
 *  fed, a `through [ … ]` stage never does. */
export type PluginCallSite = 'plain' | 'stage';

/** A positional call that does not fit the plugin's parameters. */
export type PluginArgMisfit =
  /** An argument past the positional parameters that is not the settings record. */
  | { kind: 'extra'; span: Span }
  /** A settings key that names a parameter taken by position. */
  | { kind: 'settingIsPositional'; name: string; span: Span }
  /** A settings record member that is not `name: value`. */
  | { kind: 'settingNotNamed'; span: Span };

/** A call's arguments, bound to the plugin's parameters by name. */
export interface PluginArgBinding {
  args: CallArg[];
  misfits: PluginArgMisfit[];
}

/** The parameters a call fills by position, in the manifest's declared
 *  order. The spec keeps the fed parameters apart from the author's, and
 *  every plugin declares its fed one first, so fed-then-author is that order. */
export function pluginPositionalParams(spec: PluginSpec, site: PluginCallSite): string[] {
  const fed = site === 'plain' ? (spec.fedArgs ?? []).filter(f => f.required === true).map(f => f.name) : [];
  const required = spec.requiredArgs ?? [];
  return [...fed, ...spec.args.filter(a => required.includes(a))];
}

/** What is wrong, in the words both checkers report (MOV_THROUGH_BAD_ARG). */
export function pluginArgMisfitMessage(misfit: PluginArgMisfit, callee: string, positional: readonly string[]): string {
  switch (misfit.kind) {
    case 'extra': {
      const byPosition =
        positional.length === 0
          ? 'no argument by position'
          : positional.length === 1
            ? `one argument by position (${positional[0]})`
            : `${positional.length} arguments by position (${positional.join(', ')})`;
      return `'${callee}' takes ${byPosition}, then its settings as one record \`{ name: value }\` — this argument is past them`;
    }
    case 'settingIsPositional':
      return `'${misfit.name}' is an argument '${callee}' takes by position — write it in its place, not in the settings record`;
    case 'settingNotNamed':
      return `'${callee}'s settings record holds only \`name: value\` entries`;
    default:
      return neverAsAny(misfit);
  }
}

/** Positional arguments named by `pluginPositionalParams`; the argument
 *  after those, written as a record literal, is the settings, each entry a
 *  named argument whose value is its own slot; any further one is a misfit.
 *  A named argument stays as written. */
export function bindPluginArgs(
  spec: PluginSpec,
  site: PluginCallSite,
  args: readonly CallArg[],
  options: { languageVersion: LanguageVersion },
): PluginArgBinding {
  const params = pluginPositionalParams(spec, site);
  const positional = args.filter(a => a.name === undefined);
  const settingsArg = positional[params.length];
  const settings = settingsArg !== undefined ? recordLiteral(settingsArg, options.languageVersion) : undefined;
  const binding: PluginArgBinding = { args: [], misfits: [] };
  let at = 0;
  for (const arg of args) {
    if (arg.name !== undefined) {
      binding.args.push(arg);
      continue;
    }
    const index = at++;
    const param = params[index];
    if (param !== undefined) {
      binding.args.push({ ...arg, name: param });
    } else if (settings !== undefined && index === params.length) {
      bindSettings(settings, params, binding);
    } else {
      binding.misfits.push({ kind: 'extra', span: callArgSpan(arg) });
    }
  }
  return binding;
}

/** A `through [ … ]` stage's arguments, bound to the plugin's parameters by name. */
export interface StageArgBinding {
  args: NamedArg[];
  misfits: PluginArgMisfit[];
}

/** A stage's positional arguments bound as a call's are, with the stage's
 *  positional parameters (never a fed one). */
export function bindStageArgs(spec: PluginSpec, stage: PluginCall, options: { languageVersion: LanguageVersion }): StageArgBinding {
  const bound = bindPluginArgs(spec, 'stage', (stage.positional ?? []).map((expr): CallArg => ({ kind: 'expr', expr })), options);
  // Binding names an expression and makes nothing else.
  const named = bound.args.flatMap((arg): NamedArg[] => (arg.kind === 'expr' && arg.name !== undefined ? [{ name: arg.name, value: arg.expr }] : []));
  return { args: [...stage.args, ...named], misfits: bound.misfits };
}

interface RecordLiteral {
  slot: ExprSlot;
  entries: MapMember[];
}

function recordLiteral(arg: CallArg, languageVersion: LanguageVersion): RecordLiteral | undefined {
  if (arg.kind !== 'expr') return undefined;
  let tree: MExpr;
  try {
    // The tree the program's own parse read; a slot without one is read
    // under the program's version.
    tree = treeOfSlot(arg.expr, languageVersion);
  } catch {
    return undefined;
  }
  return tree.kind === 'map' ? { slot: arg.expr, entries: tree.entries } : undefined;
}

/** An entry's value as a slot of its own: its text, and the tree the
 *  record's parse read for it, its offsets moved to that text. */
function entrySlot(record: RecordLiteral, value: MExpr, span: Span): ExprSlot {
  const slot: ExprSlot = { raw: record.slot.raw.slice(value.at.start, value.at.end), span };
  slotTrees.set(slot, shiftedTree(value, value.at.start));
  return slot;
}

/** The tree (plain JSON, as the parser handed it over) with every offset
 *  moved back by `by`. */
function shiftedTree(tree: MExpr, by: number): MExpr {
  return JSON.parse(JSON.stringify(tree), (key: string, value: unknown) =>
    key === 'at' && isAt(value) ? { start: value.start - by, end: value.end - by } : value,
  );
}

function isAt(value: unknown): value is At {
  return typeof value === 'object' && value !== null && 'start' in value && 'end' in value
    && typeof value.start === 'number' && typeof value.end === 'number';
}

function bindSettings(record: RecordLiteral, params: readonly string[], binding: PluginArgBinding): void {
  const spanOf = (at: At): Span => ({ start: locIn(record.slot, at.start), end: locIn(record.slot, at.end) });
  for (const member of record.entries) {
    if (isMapSpread(member)) {
      binding.misfits.push({ kind: 'settingNotNamed', span: spanOf(member.at) });
      continue;
    }
    const { key, value } = member;
    if (key.quoted === 'string') {
      binding.misfits.push({ kind: 'settingNotNamed', span: spanOf(key.at) });
      continue;
    }
    if (params.includes(key.text)) {
      binding.misfits.push({ kind: 'settingIsPositional', name: key.text, span: spanOf(key.at) });
      continue;
    }
    binding.args.push({
      kind: 'expr',
      name: key.text,
      expr: entrySlot(record, value, spanOf(value.at)),
    });
  }
}

/** The file's line and column of `offset` into a slot's text. */
function locIn(slot: ExprSlot, offset: number): Loc {
  let { line, col } = slot.span.start;
  for (let i = 0; i < Math.min(offset, slot.raw.length); i++) {
    if (slot.raw[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

/** Where an argument is written, whatever form it takes. */
export function callArgSpan(arg: CallArg): Span {
  switch (arg.kind) {
    case 'expr':
      return arg.expr.span;
    case 'write':
      return arg.write.span;
    case 'node':
      return arg.node.span;
    case 'call':
      return arg.call.span;
    case 'closure':
    case 'type':
      return arg.span;
    default:
      return neverAsAny(arg);
  }
}

/** What a plain call to `spec`'s plugin hands back to a program pinned to
 *  `languageVersion` — its current output, or an older shape it kept for
 *  programs pinned before the change (`PluginSpec.earlierOutputs`). */
export function pluginOutputUnder(spec: PluginSpec, languageVersion: LanguageVersion): PluginOutput | undefined {
  const earlier = spec.earlierOutputs?.find((entry) => before(languageVersion, entry.before));
  return earlier !== undefined ? earlier.output : spec.output;
}

// ── Field value types ──

/**
 * The value type of a field/property. Deliberately small: enough to catch
 * shape mistakes (text into a number field, a string into a file slot)
 * without reproducing every adapter's type system.
 */
export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  // A calendar day (normalised to midnight UTC) — `date` — versus an instant —
  // `datetime`. Both are temporal and mutually comparable (a date is midnight).
  | 'date'
  | 'datetime'
  | 'file'
  /**
   * A structured value — the DATA top type, TypeScript's `unknown` for the
   * data plane. Every data shape is assignable TO it (text, number, boolean,
   * date/datetime, a list of data, an object literal, json itself); `file` is
   * not, because a file is a HANDLE, not data. Nothing is assignable FROM it:
   * a json value has no known shape, so operating on one (arithmetic,
   * comparison, text concatenation) is an error and the author passes it
   * through unchanged. Narrowing constructs are deliberately absent — an
   * adapter field declared `json` mirrors the target API verbatim, which is
   * the point (plans/slack-blocks-json-fields-2026-07-30).
   */
  | 'json'
  /**
   * The type of the `null` LITERAL, and of nothing else — TypeScript's `null`
   * under strictNullChecks. It is the one value every `T | absent` may turn out
   * to be, which is what makes `x == null` a legal comparison at any `T` and a
   * meaningful one only where absence is possible. No adapter surface declares
   * it (a field is `T` or `maybeAbsent(T)`, never this), so it reaches nothing
   * outside the checker's own expression typing.
   */
  | 'absent'
  /**
   * The type of a value that never arrives — `fail("…")` written inside an
   * expression (language version 5) — TypeScript's `never`. It fits every
   * type, and a union with it is the union's other members.
   */
  | 'never'
  /**
   * A collection of values. `unordered` is the ORDER discipline's value-plane
   * half: the list's members are there, but the sequence they are in means
   * nothing, so an order-sensitive fold over it is refused. A list is a
   * sequence by construction (a literal, a source's own multi-value field, a
   * tuple), so the flag is the exception, set only where the order genuinely
   * came from nowhere — a block bound over an unordered traversal, a `COLLECT`
   * of one. The position plane carries the same fact differently (a walk's
   * last hop is sequenced, or it isn't), exactly as absence does.
   */
  | { kind: 'list'; of: FieldType; unordered?: true }
  /**
   * `<[T, U]>` — a heterogeneous list whose slots were written down: a list
   * literal (`[m.Body, file]` is `[text, file]`, from language version 3;
   * earlier versions type a literal as the list it reads as) and the receipt of a
   * combinator written with literal arms (`await parallel([f, g])`). Every slot
   * is its own type, so a literal-index read (`AT(r, 0)`) types exactly; every
   * other operation reads a tuple as the list it widens to — TypeScript's
   * tuple-to-array assignability.
   *
   * A slot is `null` where the value could not be typed — "we could not see",
   * spelled with the one nothing-value JSON can carry, since this type crosses
   * the wire verbatim. `'absent'` is the other answer and means the opposite:
   * this arm hands nothing back, so the slot's VALUE is always null at run
   * time.
   *
   * `rest` makes the tuple VARIADIC — TypeScript's `[T, ...U[]]`: a run of
   * any length (zero included) of `rest.of`, sitting just before slot
   * `rest.at` (`at === of.length` puts it last). A spread of a list into a
   * literal is what writes one: `[m.Body, ...files]` is `[text, ...file[]]`.
   * There is at most one run — a second spread folds everything from the
   * first run onward into it, as TypeScript does.
   */
  | { kind: 'tuple'; of: Array<FieldType | null>; rest?: TupleRest }
  /**
   * `{ k: v, … }` — a collection keyed by TEXT. Keys are strings and nothing
   * else: a dict is JSON-object-shaped, which is the whole value world's one
   * story (snapshots, `json` interop, the wire), and JSON has no other key. A
   * key that arrives as some other type is a save error demanding the author
   * write the coercion down, never a silent stringification.
   *
   * `of` is what a key nobody wrote down may hold: the value type every key
   * shares, or `json` when they disagree — json is the data type every value
   * flows into. (A value union exists, but only as what a tuple widens to.)
   *
   * `shape` is the TypeScript object literal's type: a dict WRITTEN as a
   * literal knows its keys, so a lookup by a literal key reads that key's own
   * type, present, and a literal key it does not have is refused. A key is
   * `null` where its value could not be typed — "we could not see", as a
   * tuple's slot is. Absent on every dict whose keys are data rather than
   * program text: `GROUPBY`/`KEYBY`'s answers, and every adapter surface.
   *
   * There is no order: a dict is looked up, never folded, so the set/list
   * discipline has nothing to say about one. What `GROUPBY` puts INSIDE it —
   * a list per key — carries the source's ordering as any other list does.
   */
  | { kind: 'dict'; of: FieldType; shape?: Record<string, FieldType | null> }
  /** `open` marks a KNOWN-VALUES field, not a closed enum: the options are
   *  what the adapter could enumerate live (Slack channels, select options),
   *  but other values remain legal — ids matching `allowPattern`, runtime
   *  expressions, values the listing couldn't see. Literal membership misses
   *  are WARNINGS with a did-you-mean, never errors. */
  | { kind: 'enum'; options: string[]; open?: { allowPattern?: string } }
  /**
   * `T | absent` — a value that MAY not be there (asks-as-adapter P20/F13). Read
   * from a PARTIAL context (a race receipt property bound in only some branches,
   * F18) or a maybe-empty node's field (an awaited landing off a `resolvesEmpty`
   * edge, F19/F20). It PROPAGATES silently through expressions; the checker
   * errors only where a NON-ABSENT value is REQUIRED (a plain write field, an
   * ordered comparison), never at the read — the TS `T | undefined` model.
   * Discharged by a `?:` (fill) write field, a traversal-as-gate, or an `==`
   * guard (equality tolerates absence and narrows). Produced ONLY by
   * the checker's typing layer; it never appears in an adapter/schema surface, so
   * runtime data (the engine, trpc) never carries it. `of` is never itself
   * `maybeAbsent` — construct via the `maybeAbsent()` helper, which flattens. */
  | { kind: 'maybeAbsent'; of: FieldType }
  /**
   * `T | U` — a value that is one of several types, TypeScript's union. It
   * arises where a tuple is READ as a list: `[text, number]` widens to a list
   * of `text | number`, as TypeScript widens `[string, number]` to
   * `(string | number)[]` (language version 3; earlier versions read such a
   * tuple as a list nobody can type).
   *
   * A union IS its member set, as a record-position union is: build one only
   * through `valueUnion`, which keeps the set canonical — flattened (no member
   * is a union), de-duplicated, sorted by display, at least two members (one
   * member is that member), absence hoisted out (`maybeAbsent` wraps the
   * union, never sits inside it), a member another member already accepts
   * absorbed (`json` takes every data shape, `text` every enum). Members are
   * VALUES: records and values have no union (a list of both is
   * `MOV_LIST_MIXED`), and records of different positions are already one
   * record type.
   *
   * Produced only by the checker's typing layer; no adapter surface declares
   * one.
   */
  | { kind: 'union'; of: FieldType[] }
  /**
   * A RECORD held as a value — a traversed record, a write handle, a
   * synthesised node, an extraction result. One type universe: a record is
   * what `MAP` hands back when its function returns one, what a list literal
   * of them holds, and what a map's key can carry, so lists and dicts nest
   * over records exactly as they nest over text.
   *
   * It is a value TYPE, not a value shape: nothing reads it as data. A record
   * written into a field, interpolated into text, added up or compared to a
   * scalar is refused where it is written; what it CAN do is be walked from
   * (a block head), read by field (the dot plane), and held in a collection.
   *
   * `position` is which record, where the checker can say — the same
   * `PositionTypeRef` the arrow plane uses, never a parallel one. ABSENT means
   * "a record, and nobody can name which": members of a list that disagree,
   * an extraction result, a synthesised node. The distinction is load-bearing
   * and is the same one `LocalEdge.target` draws — a walk off a record whose
   * position is unknown stays silent and runs, and one off a named position is
   * checked.
   */
  | { kind: 'record'; position?: PositionTypeRef };

/** A variadic tuple's run: any number of `of`, just before slot `at`. `of` is
 *  `null` where the run's members could not be typed. */
export interface TupleRest {
  at: number;
  of: FieldType | null;
}

/**
 * A field type spelled as ONE tagged variant — the scalars given the `kind`
 * the collections already carry.
 *
 * `FieldType` is half bare names and half objects, so a `switch` could never
 * see it whole: every branch over it was a `typeof === 'object'` if-chain, the
 * compiler enumerated nothing, and a new variant silently took whichever
 * fallthrough happened to come last. Both halves here are DERIVED from the
 * type parameter, so this is not a second list to keep in step — add a variant
 * to `FieldType` and every `switch` over a variant stops compiling at once.
 *
 * Generic in the type it normalises so a `SchemaFieldType` stays one: its
 * `list` still holds a `SchemaFieldType`, and its switch still has no `record`
 * case to answer.
 */
export type FieldTypeVariant<T extends FieldType = FieldType> =
  | { kind: Extract<T, string> }
  | Extract<T, { kind: string }>;

/**
 * The tag for each bare name, shared rather than built per call: `stripAbsent`
 * and `fieldTypeEquals` run over every expression the checker walks, and a
 * normaliser that allocated would put that cost on a path that had none.
 *
 * The mapped type is the third place a new bare name has to be answered — add
 * one to `FieldType` and this table is missing a key.
 */
const SCALAR_VARIANTS: { [K in Extract<FieldType, string>]: { kind: K } } = {
  text: { kind: 'text' },
  number: { kind: 'number' },
  boolean: { kind: 'boolean' },
  date: { kind: 'date' },
  datetime: { kind: 'datetime' },
  file: { kind: 'file' },
  json: { kind: 'json' },
  absent: { kind: 'absent' },
  never: { kind: 'never' },
};

/**
 * Normalise a field type for an exhaustive `switch (variantOf(t).kind)`.
 *
 * The one assertion is the boundary the whole scheme rests on: `typeof` cannot
 * prove to TypeScript that a GENERIC `T`'s string half is `Extract<T, string>`,
 * though it is, by construction of the union.
 */
export function variantOf<T extends FieldType>(type: T): FieldTypeVariant<T> {
  const wide: FieldType = type;
  return (typeof wide === 'string' ? SCALAR_VARIANTS[wide] : wide) as FieldTypeVariant<T>;
}

/** Maps a surface type name (shape declarations, extract annotations) to a SchemaFieldType. */
/**
 * The type a `type Thesis = <"A" | "B">` declaration names — a CLOSED enum,
 * identical in shape to an option set borrowed from a live field, so nothing
 * downstream (extraction prompt, literal check, did-you-mean) can tell a
 * written refinement from a fetched one.
 */
export function declaredTypeOf(decl: TypeDeclaration): SchemaFieldType {
  return { kind: 'enum', options: decl.options };
}

/**
 * Every refinement a program declares, by name. A `type` is a FILE-level
 * declaration, so this flat map and the checker's scope resolution answer the
 * same question — the engine, which has no scopes, asks it this way.
 */
export function declaredTypesIn(program: Program): Map<string, SchemaFieldType> {
  const declared = new Map<string, SchemaFieldType>();
  for (const statement of program.statements) {
    if (statement.kind === 'type') declared.set(statement.name, declaredTypeOf(statement));
  }
  return declared;
}

export function parseFieldTypeName(name: string | undefined): SchemaFieldType | undefined {
  switch (name) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
      return name;
    default:
      return undefined;
  }
}

// ── Borrowed types ───────────────────────────────────────────────────────────
//
// An extract field's type may be BORROWED from another graph's field by
// path — `stage: crm.companies.funding_stage` — instead of declared
// inline. The path is `<instance>.<root-or-position>.<field>`, resolved
// against the instance's live schema (so an Attio select that gains an
// option is followed; nothing is copied out). The checker resolves it
// from the catalog for diagnostics; the engine re-resolves per firing.

/** The dotted segments of a borrowed-type annotation, or undefined for a
 *  plain (primitive) type name. */
export function borrowedTypeSegments(name: string | undefined): string[] | undefined {
  if (name === undefined || !name.includes('.')) return undefined;
  return name.split('.');
}

/**
 * The borrowable fields of one root/position of a schema: the writable
 * root's fields unioned with the position's properties. Writable fields
 * win per-name — enums (select options) live on the write surface.
 * Undefined when the schema has no root or position of that name.
 */
export function borrowableFieldsOf(
  schema: InstanceSchema,
  rootName: string,
): Record<string, SchemaFieldType> | undefined {
  const writable = schema.writableRoots[rootName]?.fields;
  const readable = schema.positions[rootName]?.properties;
  if (!writable && !readable) return undefined;
  return { ...(readable ?? {}), ...(writable ?? {}) };
}

/** Resolve `<root>.<field>` of a borrowed path against a schema. */
export function resolveBorrowedField(
  schema: InstanceSchema,
  rootName: string,
  fieldName: string,
): SchemaFieldType | undefined {
  return borrowableFieldsOf(schema, rootName)?.[fieldName];
}

export function describeFieldType(type: FieldType): string {
  const variant = variantOf(type);
  switch (variant.kind) {
    // `absent` is the one bare name that is NOT its surface spelling — the
    // author writes `null`, and there is no annotation to paste back (no field
    // is declared this type).
    case 'absent':
      return 'null';
    // A bare type name IS its surface spelling — `json` included — and the
    // annotation suggestions paste this text back into a program, so it must
    // stay the word `parseFieldTypeName` reads.
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
    case 'never':
      return variant.kind;
    case 'maybeAbsent':
      return `${describeMember(variant.of)} (or absent)`;
    case 'list':
      return `list of ${describeMember(variant.of)}`;
    // TypeScript's own notation, because that is what the type is.
    case 'union':
      return variant.of.map(describeFieldType).join(' | ');
    // A tuple IS its slots, in order — the surface spelling, so a diagnostic
    // can paste it back. An untyped slot reads as `?`, which is what the
    // checker knows, not a type it is claiming.
    case 'tuple': {
      const slots = variant.of.map(slot => (slot === null ? '?' : describeFieldType(slot)));
      if (variant.rest !== undefined) {
        const run = variant.rest.of === null ? '?' : describeMember(variant.rest.of);
        slots.splice(variant.rest.at, 0, `...list of ${run}`);
      }
      return `[${slots.join(', ')}]`;
    }
    // A shaped dict IS its keys — the literal's own spelling, the way a tuple
    // reads as its slots.
    case 'dict':
      if (variant.shape !== undefined) {
        const keys = Object.entries(variant.shape).map(
          ([key, slot]) => `${key}: ${slot === null ? '?' : describeFieldType(slot)}`,
        );
        return `{ ${keys.join(', ')} }`;
      }
      return `dict of ${describeMember(variant.of)}`;
    // A record reads as the record it IS, in the arrow plane's own words. A
    // record nobody can name is still definitely a record, which is what the
    // absent ref means and what the reader needs to hear.
    case 'record':
      return variant.position !== undefined ? describePosition(variant.position) : 'a record';
    case 'enum':
      if (variant.open) return `known values (${variant.options.join(' | ')}, …)`;
      // An empty CLOSED option set is the empty union — `enum ()` reads like a
      // rendering bug, so name the fact.
      if (variant.options.length === 0) return 'enum (no available values)';
      return `enum (${variant.options.join(' | ')})`;
    default:
      return neverAsAny(variant);
  }
}

/** A type spelled inside another — parenthesised when it is a union, as
 *  TypeScript writes `(string | number)[]`, so `list of (text | number)` cannot
 *  be read as `(list of text) | number`. */
function describeMember(type: FieldType): string {
  const described = describeFieldType(type);
  return typeof type !== 'string' && type.kind === 'union' ? `(${described})` : described;
}

/**
 * May a check state that this position's surface LACKS something?
 *
 * No, on any of the three facts above: an OPEN position says its surface is
 * wider than what's enumerated, an UNDESCRIBED one says nothing at all, and a
 * PENDING one has not been asked yet — none licenses "it has no field X".
 *
 * They stay separate fields because they answer a DIFFERENT question
 * differently: may the author touch the handle? An open position, yes (it is a
 * positive claim); an undescribed one, no (`MOV_UNDESCRIBED_POSITION`); a
 * pending one, yes-for-now — silently, because the answer is still coming and
 * the author has done nothing wrong. This helper is only for the first
 * question, and exists so no call site has to remember to ask about all three.
 */
export function surfaceNotEnumerated(schema: PositionSchema | undefined): boolean {
  return (
    schema?.openProperties === true || schema?.undescribed === true || schema?.pending === true
  );
}

/** Whether a write may land on this edge. The two promises default OPPOSITE
 *  ways — `readable` absent means readable, `writable` absent means read-only
 *  (layer 13) — which is exactly the asymmetry a second reader gets wrong. So
 *  everyone who asks asks HERE: the checker's gate, the diagnostics that list
 *  the writable spellings, and the agent-facing describe surface. They cannot
 *  answer differently if there is only one answer. */
export function edgeIsWritable(edge: EdgeSchema): boolean {
  return edge.writable === true;
}

/** Whether a read traversal may walk this edge — the other half of the pair
 *  above, and the one that defaults TRUE (only `readable: false` withdraws it,
 *  marking a write-only edge). */
export function edgeIsReadable(edge: EdgeSchema): boolean {
  return edge.readable !== false;
}

/** Every WRITABLE edge an instance offers, for diagnostics: the spellings a
 *  write can land on (`channel-[:messages]->`, `message-[:replies]->`). Keys
 *  off the one explicit `writable` promise (layer 13). */
export function writableEdgesOf(
  schema: InstanceSchema,
): Array<{ parent: string; edge: string; target: string }> {
  const out: Array<{ parent: string; edge: string; target: string }> = [];
  for (const [parent, position] of Object.entries(schema.positions)) {
    for (const [edge, edgeSchema] of Object.entries(position.edges)) {
      if (edgeIsWritable(edgeSchema)) out.push({ parent, edge, target: edgeSchema.target });
    }
  }
  return out;
}
