/**
 * Formula language for expression editing.
 *
 * Provides serialization (AST → text), parsing (text → AST),
 * and cursor-context-aware completion hints.
 *
 * Grammar (simplified):
 *   expr       = or_expr
 *   or_expr    = and_expr ('OR' and_expr)*
 *   and_expr   = not_expr ('AND' not_expr)*
 *   not_expr   = ('NOT' | '!') not_expr | compare
 *   compare    = additive (comp_op additive)?
 *   additive   = mult (('+' | '-') mult)*
 *   mult       = unary (('*' | '/' | '%') unary)*
 *   unary      = '-' unary | primary
 *   primary    = '(' expr ')' | if_expr | fn_call | literal | identifier
 *   if_expr    = 'IF' expr 'THEN' expr ('ELSE' 'IF' expr 'THEN' expr)* 'ELSE' expr 'END'
 *   fn_call    = IDENT '(' expr (',' expr)* ')'
 *   literal    = string | number | 'true' | 'false' | 'null' | list | object
 *   list       = '[' (expr (',' expr)* ','?)? ']'
 *   object     = '{' (entry (',' entry)* ','?)? '}'
 *   entry      = (IDENT | string) ':' expr
 *   identifier = [a-zA-Z_][a-zA-Z0-9_ ]* | `backtick quoted`
 */

import type { Expression, FilterOperator, ListElement, ObjectEntry, TraversalStep, EdgeStep, MetaEdgeStep, EnrichWithEntry } from './types';
import { AI_TIERS, isObjectSpread, listElementExpression, mapListElement, objectMemberExpression } from './types';


// ── Property name resolution ──

export interface PropertyInfo {
  id: string;
  name: string;
  nodeTypeId?: string; // which node type this belongs to (for scoped completions)
  edgeTypeId?: string; // for edge properties: the edge type they hang off (scopes `edge.X` completions to the just-walked edge)
  valueType?: string; // e.g. 'text', 'number', 'boolean', 'date', 'enum'
  enumValues?: string[];
  isEdge?: boolean;
  /** Property arity. `'many'` declares the value is an array of
   *  `valueType` rather than a single instance — drives the type
   *  inferer to wrap the property's type in `{ kind: 'many', ... }`. */
  cardinality?: 'one' | 'many';
  /** Optional human description, surfaced by the editor's caret hints. */
  description?: string;
}

export interface EdgeInfo {
  id: string;
  outboundName: string;
  inboundName: string;
  sourceNodeTypeId: string;
  targetNodeTypeId: string;
}

// ── Capability gating ──
// When the source-side adapter doesn't support a feature, the formula
// completion engine should hide the corresponding token. KG-source defaults
// (everything = true) preserve the historical behavior when no capabilities
// object is supplied.
//
// `expressionKinds` and `aggregations` let the UI gate token completions by
// the adapter's full expression dialect (per the AdapterExpressionCapabilities
// `runtime` surface). When absent, every kind/aggregation is offered.
export interface FormulaCapabilities {
  incomingEdges: boolean;
  edgeProperties: boolean;
  linkedObjects: boolean;
  resources: boolean;
  llm: boolean;
  /**
   * KG-bound global identifiers (`@id`, `@user_*`, `@parent.*`,
   * `@current_date`, `@input_channel_name`). True for the TG field
   * editor where these resolve against the surrounding action node /
   * pipeline context. False for adapter-source filter authoring (trigger
   * filters) where there's no parent action node and no KG node id in
   * scope. Optional; defaults to true.
   */
  kgGlobals?: boolean;
  expressionKinds?: readonly string[];
  aggregations?: readonly string[];
}

const DEFAULT_CAPABILITIES: FormulaCapabilities = {
  incomingEdges: true,
  edgeProperties: true,
  linkedObjects: true,
  resources: true,
  llm: true,
  kgGlobals: true,
};

/** Map from completion token's `insert` prefix to the Expression kind it
 *  produces. Only kinds we care to gate appear here; properties / static
 *  values / etc. are always available. */
const COMPLETION_KIND_MAP: Record<string, { kind: string; aggFn?: string }> = {
  IF: { kind: 'conditional' },
  NOT: { kind: 'not' },
  'CONCAT(': { kind: 'concat' },
  'COALESCE(': { kind: 'function' },
  'AI(': { kind: 'llm' },
  'FIRST(': { kind: 'aggregate', aggFn: 'first' },
  'LAST(': { kind: 'aggregate', aggFn: 'last' },
  'COUNT(': { kind: 'aggregate', aggFn: 'count' },
  'SUM(': { kind: 'aggregate', aggFn: 'sum' },
  'AVG(': { kind: 'aggregate', aggFn: 'avg' },
  'MIN(': { kind: 'aggregate', aggFn: 'min' },
  'MAX(': { kind: 'aggregate', aggFn: 'max' },
  'JOIN(': { kind: 'aggregate', aggFn: 'join' },
  'ONLY(': { kind: 'aggregate', aggFn: 'only' },
  'KG_EXISTS(': { kind: 'kg_exists' },
  'KG_VALUE(': { kind: 'kg_value' },
  'WITHIN(': { kind: 'function' },
};

/** Filter a list of completions by the active capability surface — drops
 *  tokens whose Expression kind (or aggregation function) isn't supported.
 *  When the capability arrays are absent, all completions are kept. */
function filterCompletionsByCaps<C extends { insert: string }>(
  completions: readonly C[],
  capabilities: FormulaCapabilities,
): C[] {
  return completions.filter((c) => {
    const m = COMPLETION_KIND_MAP[c.insert];
    if (!m) return true;
    if (
      capabilities.expressionKinds &&
      !capabilities.expressionKinds.includes(m.kind)
    ) {
      return false;
    }
    if (
      m.aggFn &&
      capabilities.aggregations &&
      !capabilities.aggregations.includes(m.aggFn)
    ) {
      return false;
    }
    return true;
  });
}

// ── Serializer: AST → formula text ──

const OP_TEXT: Record<FilterOperator, string> = {
  eq: '=', neq: '!=', contains: 'contains', gt: '>', gte: '>=', lt: '<', lte: '<=',
  exists: 'exists', in: 'in', within: 'WITHIN',
};

const MATH_TEXT: Record<string, string> = { '+': '+', '-': '-', '*': '*', '/': '/', '%': '%' };

export const AGG_NAMES: Record<string, string> = {
  first: 'FIRST', last: 'LAST', only: 'ONLY', count: 'COUNT', sum: 'SUM', avg: 'AVG',
  min: 'MIN', max: 'MAX', join: 'JOIN', collect: 'COLLECT', llm: 'LLM_AGG',
};

function isSimpleExpression(expr: Expression): boolean {
  switch (expr.type) {
    case 'property':
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'action_result':
    case 'resource':
    case 'linked_object':
      return true;
    default:
      return false;
  }
}

export function needsQuote(name: string): boolean {
  return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export function quoteName(name: string): string {
  return needsQuote(name) ? '`' + name.replace(/[\\`]/g, '\\$&') + '`' : name;
}

function quoteString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * An object-literal key in its two authored forms: bare when the parser reads
 * it straight back as a key, a quoted string otherwise. A reserved word takes
 * the quoted form too — the tokenizer folds it to an (upper-cased) keyword, so
 * a bare `end:` would not round-trip.
 */
function serializeObjectKey(key: string): string {
  return !needsQuote(key) && !KEYWORDS.has(key.toUpperCase()) ? key : quoteString(key);
}

function serializeResourceFilter(filter?: { resourceType?: string; hasDocument?: boolean; mimeType?: string; namePattern?: string }): string {
  if (!filter) return '';
  const clauses: string[] = [];
  if (filter.resourceType) clauses.push(`type = "${filter.resourceType}"`);
  if (filter.hasDocument != null) clauses.push(filter.hasDocument ? 'hasDocument' : 'hasDocument = false');
  if (filter.mimeType) clauses.push(`mimeType = "${filter.mimeType}"`);
  if (filter.namePattern) clauses.push(`namePattern = "${filter.namePattern}"`);
  if (clauses.length === 0) return '';
  return ` WHERE ${clauses.join(' AND ')}`;
}

export function serialize(
  expr: Expression,
  resolve: (id: string, isEdge?: boolean) => string,
  parentPrec = 0,
  resolveStaticValue?: (value: string) => string,
  resolveEdgeInfo?: (id: string) => EdgeInfo | undefined,
): string {
  switch (expr.type) {
    case 'property':
      return quoteName(resolve(expr.propertyTypeId));
    case 'edge_property':
      return 'edge.' + quoteName(resolve(expr.propertyTypeId, true));
    case 'static':
      if (typeof expr.value === 'string') {
        const display = resolveStaticValue ? resolveStaticValue(expr.value) : expr.value;
        return quoteString(display);
      }
      if (expr.value === null) return 'null';
      return String(expr.value);
    case 'llm': {
      // The tier rides along: a call spelled back without it would read as a
      // different call from the one that runs.
      const tier = expr.tier !== undefined ? `, ${quoteString(expr.tier)}` : '';
      if (expr.promptExpression) {
        return `AI(${serialize(expr.promptExpression, resolve, 0, resolveStaticValue, resolveEdgeInfo)}${tier})`;
      }
      return `AI(${quoteString(expr.prompt)}${tier})`;
    }
    case 'meta':
      return '@' + expr.key;
    case 'parent_result':
      return '@parent.' + expr.field;
    case 'action_result':
      // Serializer-led (like `exists`) — compiler-emitted, no parser entry.
      return `RESULT(${quoteName(expr.nodeId)}).${quoteName(expr.field)}`;
    case 'resource':
      return '@resource.' + expr.field;
    case 'linked_object':
      return `-[#linked WHERE type = "${expr.adapter}"]->.${expr.field}`;
    case 'extract_value':
      return `EXTRACT_VALUE(${quoteString(expr.description)})`;
    case 'alias_ref':
      return quoteName(expr.name);
    case 'list':
      return `[${expr.elements.map(e => (e.type === 'spread' ? `...${ser(e.expression)}` : ser(e))).join(', ')}]`;
    case 'object':
      return `{${expr.entries.map(e => (isObjectSpread(e) ? `...${ser(e.expression)}` : `${serializeObjectKey(e.key)}: ${ser(e.value)}`)).join(', ')}}`;
    case 'traverse': {
      const steps = expr.steps.map(s => serializeTraversalStep(s, resolve, resolveStaticValue, resolveEdgeInfo));
      const inner = ser(expr.expression);
      const needsBrackets = !isSimpleExpression(expr.expression);
      const root = expr.aliasRoot ? quoteName(expr.aliasRoot) : '';
      // Dot-chain with aliasRoot but zero steps: render `alias.expression`
      // (no leading arrow). Steps-only path keeps the existing form.
      if (expr.aliasRoot && expr.steps.length === 0) {
        return `${root}.${needsBrackets ? `(${inner})` : inner}`;
      }
      return `${root}${steps.join('')}.${needsBrackets ? `(${inner})` : inner}`;
    }
    case 'resource_traverse': {
      const where = expr.expressionFilter
        ? ` WHERE ${ser(expr.expressionFilter)}`
        : serializeResourceFilter(expr.filter);
      const inner = expr.expression.type === 'resource'
        ? expr.expression.field
        : ser(expr.expression);
      return `-[:_resources${where}]->.${inner}`;
    }
    case 'compare': {
      const prec = 3;
      // `WITHIN`'s right operand is a duration literal — render it bare
      // (`updated WITHIN 30d`), not as a quoted string.
      if (expr.op === 'within') {
        const dur = expr.right.type === 'static' ? String(expr.right.value) : ser(expr.right, prec + 1);
        const inner = `${ser(expr.left, prec)} WITHIN ${dur}`;
        return parentPrec > prec ? `(${inner})` : inner;
      }
      const inner = `${ser(expr.left, prec)} ${OP_TEXT[expr.op]} ${ser(expr.right, prec + 1)}`;
      return parentPrec > prec ? `(${inner})` : inner;
    }
    case 'arithmetic': {
      const prec = expr.op === '*' || expr.op === '/' || expr.op === '%' ? 5 : 4;
      const inner = `${ser(expr.left, prec)} ${MATH_TEXT[expr.op]} ${ser(expr.right, prec + 1)}`;
      return parentPrec > prec ? `(${inner})` : inner;
    }
    case 'logical': {
      const prec = expr.op === 'and' ? 2 : 1;
      const inner = expr.operands.map(o => ser(o, prec + 1)).join(` ${expr.op.toUpperCase()} `);
      return parentPrec > prec ? `(${inner})` : inner;
    }
    case 'not': {
      return `NOT ${ser(expr.expression, 6)}`;
    }
    case 'negate': {
      // Precedence 6: above mult (5), so `-a * b` and `a * -b` never need
      // parens; below nothing, so a nested arithmetic operand always does
      // (`-(a + b)`).
      const prec = 6;
      const inner = `-${ser(expr.expression, prec)}`;
      return parentPrec > prec ? `(${inner})` : inner;
    }
    case 'concat': {
      return `CONCAT(${expr.parts.map(p => ser(p)).join(', ')})`;
    }
    case 'conditional': {
      return serializeConditional(expr, ser);
    }
    case 'aggregate': {
      const fn = AGG_NAMES[expr.fn] ?? expr.fn.toUpperCase();
      const args = [ser(expr.expression)];
      // SORT's own two slots — the key, then the direction, each written only
      // when it was (an ascending sort by the member itself is `SORT(xs)`).
      if (expr.fn === 'sort') {
        if (expr.orderBy !== undefined) args.push(ser(expr.orderBy));
        if (expr.orderDirection === 'desc') args.push('DESC');
        return `${fn}(${args.join(', ')})`;
      }
      if (expr.separator !== undefined) args.push(quoteString(expr.separator));
      if (expr.prompt !== undefined) args.push(quoteString(expr.prompt));
      return `${fn}(${args.join(', ')})`;
    }
    case 'function': {
      return `${expr.fn.toUpperCase()}(${expr.args.map(a => ser(a)).join(', ')})`;
    }
    case 'kg_exists':
    case 'kg_value': {
      const fnName = expr.type === 'kg_exists' ? 'KG_EXISTS' : 'KG_VALUE';
      const args = [quoteString(expr.query), ...expr.params.map(p => ser(p))];
      return `${fnName}(${args.join(', ')})`;
    }
    case 'exists': {
      const pathRefs: string[] = [];
      for (const step of expr.steps) {
        if (step.type === 'edge') {
          const dir = step.direction === 'outgoing' ? '->' : '<-';
          pathRefs.push(`${dir}${quoteName(resolve(step.edgeTypeId, true))}`);
        } else if (step.type === 'resource') {
          pathRefs.push('->resource');
        } else if (step.type === 'linkBack') {
          pathRefs.push('->link_back');
        }
      }
      const path = pathRefs.join('');
      if (expr.where) return `EXISTS(${path} WHERE ${ser(expr.where)})`;
      return `EXISTS(${path})`;
    }
    case 'at': {
      return `AT(${ser(expr.expression)}, ${ser(expr.index)})`;
    }
  }

  // Shorthand for recursive calls that threads resolveStaticValue/resolveEdgeInfo through
  function ser(e: Expression, prec = 0): string {
    return serialize(e, resolve, prec, resolveStaticValue, resolveEdgeInfo);
  }
}

/** Serialize an expression in edge filter context: edge_property → just the name (no edge. prefix) */
function serializeEdgeFilter(expr: Expression, resolve: (id: string, isEdge?: boolean) => string, resolveStaticValue?: (value: string) => string): string {
  if (expr.type === 'edge_property') {
    return quoteName(resolve(expr.propertyTypeId, true));
  }
  switch (expr.type) {
    case 'compare':
      return `${serializeEdgeFilter(expr.left, resolve, resolveStaticValue)} ${OP_TEXT[expr.op]} ${serializeEdgeFilter(expr.right, resolve, resolveStaticValue)}`;
    case 'logical':
      return expr.operands.map(o => serializeEdgeFilter(o, resolve, resolveStaticValue)).join(` ${expr.op.toUpperCase()} `);
    case 'not':
      return `NOT ${serializeEdgeFilter(expr.expression, resolve, resolveStaticValue)}`;
    default:
      return serialize(expr, resolve, 0, resolveStaticValue);
  }
}

/** Render an EdgeStep's bracket ORDER BY / LIMIT suffix (`'' ` when the
 *  step carries neither). The key renders as the expression it is — a bare
 *  property by resolved name, a path as the path. */
export function serializeOrderLimitSuffix(
  step: EdgeStep,
  resolve: (id: string, isEdge?: boolean) => string,
  resolveStaticValue?: (value: string) => string,
  resolveEdgeInfo?: (id: string) => EdgeInfo | undefined,
): string {
  const cardinality = step.cardinality;
  if (!cardinality) return '';
  let suffix = '';
  if (cardinality.orderBy !== undefined) {
    suffix += ` ORDER BY ${serialize(cardinality.orderBy, resolve, 0, resolveStaticValue, resolveEdgeInfo)}`;
    if (cardinality.orderDirection === 'desc') suffix += ' DESC';
  }
  if (cardinality.limit !== undefined) suffix += ` LIMIT ${cardinality.limit}`;
  return suffix;
}

export function serializeTraversalStep(step: TraversalStep, resolve: (id: string, isEdge?: boolean) => string, resolveStaticValue?: (value: string) => string, resolveEdgeInfo?: (id: string) => EdgeInfo | undefined): string {
  if (step.type === 'edge') {
    const where = (step.expressionFilter
      ? ` WHERE ${serializeEdgeFilter(step.expressionFilter, resolve, resolveStaticValue)}`
      : '') + serializeOrderLimitSuffix(step, resolve, resolveStaticValue, resolveEdgeInfo);
    // alias form is `-[name:Edge]->`; anonymous form is `-[:Edge]->`.
    // Both share the same single colon separator before the edge name —
    // the alias goes BEFORE the colon, replacing the leading empty slot.
    const aliasPrefix = step.alias ? quoteName(step.alias) : '';
    // When edge info is available, always display as outgoing using the appropriate name
    if (resolveEdgeInfo) {
      const info = resolveEdgeInfo(step.edgeTypeId);
      const name = info
        ? (step.direction === 'incoming' ? info.inboundName : info.outboundName)
        : resolve(step.edgeTypeId, true);
      const quoted = needsQuote(name) ? '`' + name + '`' : name;
      return `-[${aliasPrefix}:${quoted}${where}]->`;
    }
    // Fallback without edge info: preserve original direction syntax
    const name = resolve(step.edgeTypeId, true);
    const quoted = needsQuote(name) ? '`' + name + '`' : name;
    return step.direction === 'incoming'
      ? `<-[${aliasPrefix}:${quoted}${where}]-`
      : `-[${aliasPrefix}:${quoted}${where}]->`;
  }
  if (step.type === 'linkBack') return '-[:linkBack]->';
  if (step.type === 'meta_edge') {
    const aliasPrefix = step.alias ? `${quoteName(step.alias)}:` : '';
    const tag = `#${step.metaEdge}`;
    if (step.metaEdge === 'resources') {
      const where = step.expressionFilter
        ? ` WHERE ${serializeEdgeFilter(step.expressionFilter, resolve, resolveStaticValue)}`
        : '';
      return `-[${aliasPrefix}${tag}${where}]->`;
    }
    // #extract / #transform — config object inside the bracket
    const parts: string[] = [];
    if (step.config?.description) {
      parts.push(`description: ${serialize(step.config.description, resolve, 0, resolveStaticValue, resolveEdgeInfo)}`);
    }
    if (step.config?.data) {
      // `data:` items are source-field references rendered as backticked
      // names (the `-[#extract { data: [`Body`] }]->` grammar). A plain
      // `serialize` would unquote simple identifiers and — worse — emit
      // empty backticks for a name that resolves to "". Backtick the
      // resolved name explicitly here so the field names always show.
      const dataParts = step.config.data.map(d => {
        if (d.type === 'property') {
          return '`' + resolve(d.propertyTypeId).replace(/`/g, '\\`') + '`';
        }
        return serialize(d, resolve, 0, resolveStaticValue, resolveEdgeInfo);
      });
      parts.push(`data: [${dataParts.join(', ')}]`);
    }
    if (step.config?.plugin) {
      parts.push(`plugin: ${serialize(step.config.plugin, resolve, 0, resolveStaticValue, resolveEdgeInfo)}`);
    }
    if (step.config?.enrichWith && step.config.enrichWith.length > 0) {
      const entryParts = step.config.enrichWith.map((entry) => {
        const t = serialize(entry.transform, resolve, 0, resolveStaticValue, resolveEdgeInfo);
        const a = serialize(entry.argument, resolve, 0, resolveStaticValue, resolveEdgeInfo);
        return `{ transform: ${t}, argument: ${a} }`;
      });
      parts.push(`enrich_with: [${entryParts.join(', ')}]`);
    }
    if (step.config?.extra) {
      for (const [k, v] of Object.entries(step.config.extra)) {
        parts.push(`${k}: ${serialize(v, resolve, 0, resolveStaticValue, resolveEdgeInfo)}`);
      }
    }
    const cfg = parts.length > 0 ? ` { ${parts.join(', ')} }` : '';
    return `-[${aliasPrefix}${tag}${cfg}]->`;
  }
  return '-[:resource]->';
}

function serializeConditional(expr: Expression & { type: 'conditional' }, ser: (e: Expression, prec?: number) => string): string {
  const parts: string[] = [];
  let current: Expression = expr;
  while (current.type === 'conditional') {
    if (parts.length === 0) {
      parts.push(`IF ${ser(current.condition)} THEN ${ser(current.then)}`);
    } else {
      parts.push(`ELSE IF ${ser(current.condition)} THEN ${ser(current.then)}`);
    }
    current = current.else;
  }
  parts.push(`ELSE ${ser(current)} END`);
  return parts.join(' ');
}

// ── Parser: formula text → AST ──
// Hand-rolled Pratt parser for performance and small bundle size.

export interface Token {
  type: 'ident' | 'string' | 'number' | 'op' | 'paren' | 'comma' | 'keyword' | 'special' | 'traverse' | 'lbracket' | 'rbracket' | 'lbrace' | 'rbrace' | 'colon' | 'spread' | 'unknown' | 'eof';
  value: string;
  pos: number;
  end: number;
  /** for traverse tokens: raw WHERE clause text */
  filterText?: string;
  /** for traverse tokens: optional alias bound at the destination (cypher `-[name:Edge]->`) */
  alias?: string;
  /** for traverse tokens: raw config-object text from `-[#extract { ... }]->` (between the outer braces) */
  configText?: string;
  /** for traverse tokens: `ORDER BY <prop>` inside the bracket (a property of the hop target) */
  orderByText?: string;
  /** for traverse tokens: `ASC`/`DESC` after ORDER BY (default asc) */
  orderDirection?: 'asc' | 'desc';
  /** for traverse tokens: `LIMIT <n>` inside the bracket */
  limitCount?: number;
}

/** Canonical reserved-word set for the formula grammar. Exported so the
 *  web editor's display lexer (syntax highlighting) classifies keywords
 *  exactly as the parser does, without maintaining a second copy. */
export const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IF', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE', 'NULL',
  'CONTAINS', 'EXISTS', 'IN',
]);
const COMPARE_KEYWORDS = new Set(['CONTAINS', 'EXISTS', 'IN']);

/** Find the token immediately before a given token in the filtered token list */
function findTokenBefore(toks: Token[], target: Token): Token | undefined {
  for (let i = 1; i < toks.length; i++) {
    if (toks[i] === target) return toks[i - 1];
  }
  return undefined;
}

/** The trailing-clause boundary inside a traversal bracket: ` ORDER BY ` /
 *  ` LIMIT ` at top level end the name / WHERE scan. */
const BRACKET_TRAILING_CLAUSE = /^\s+(ORDER\s+BY|LIMIT)\s/i;

/** Skip whitespace INSIDE a traversal bracket — newlines and tabs included, so
 *  a long `-[…]->` hop (WHERE / ORDER BY / LIMIT) may wrap across lines. The
 *  bracket is delimited by `]`, not by newlines. */
function skipBracketWs(input: string, i: number): number {
  while (i < input.length && /\s/.test(input[i])) i++;
  return i;
}

/** ` ASC` / ` DESC` closing an ORDER BY key, at the key's top level. */
const ORDER_DIRECTION_CLAUSE = /^\s+(ASC|DESC)(\s|\]|$)/i;

/**
 * Parse trailing `ORDER BY <key> [ASC|DESC]` / `LIMIT <n>` clauses inside a
 * traversal bracket — `-[c:companies WHERE … ORDER BY \`created_at\` DESC
 * LIMIT 10]->`, `-[e:Entries ORDER BY e-[:Signal]->.\`Discovered At\` DESC]->`.
 *
 * The key is an EXPRESSION over the element the hop lands on, so it is read
 * here as TEXT — up to the direction, the LIMIT, or the hop's own `]` — and
 * parsed by whichever lowering owns the resolvers (exactly how the WHERE is
 * handled). Nested brackets, parens and quotes are tracked so a sub-hop or a
 * string inside the key doesn't end it early.
 *
 * Returns how much input was consumed.
 *
 */
function parseBracketOrderLimit(input: string, start: number): {
  orderByText?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  length: number;
} {
  let i = start;
  const out: { orderByText?: string; orderDirection?: 'asc' | 'desc'; limit?: number; length: number } = { length: 0 };
  i = skipBracketWs(input, i);
  const orderMatch = /^ORDER\s+BY\s+/i.exec(input.slice(i));
  if (orderMatch) {
    i += orderMatch[0].length;
    const keyStart = i;
    let depth = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '`') {
        // A backtick-quoted name is opaque: LIMIT, DESC and `]` inside it are
        // part of the name.
        i++;
        while (i < input.length && input[i] !== '`') {
          if (input[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const q = ch;
        i++;
        while (i < input.length && input[i] !== q) {
          if (input[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === '(' || ch === '[') { depth++; i++; continue; }
      if (ch === ')') { depth--; i++; continue; }
      if (ch === ']') {
        if (depth === 0) break; // the hop's own closing bracket
        depth--;
        i++;
        continue;
      }
      if (depth === 0 && (ORDER_DIRECTION_CLAUSE.test(input.slice(i)) || BRACKET_TRAILING_CLAUSE.test(input.slice(i)))) {
        break;
      }
      i++;
    }
    const keyText = input.slice(keyStart, i).trim();
    if (keyText) {
      out.orderByText = keyText;
      i = skipBracketWs(input, i);
      const dir = /^(ASC|DESC)\b/i.exec(input.slice(i));
      if (dir) {
        out.orderDirection = dir[1].toLowerCase() as 'asc' | 'desc';
        i += dir[1].length;
      }
    }
  }
  i = skipBracketWs(input, i);
  const limitMatch = /^LIMIT\s+(\d+)/i.exec(input.slice(i));
  if (limitMatch) {
    out.limit = Number(limitMatch[1]);
    i += limitMatch[0].length;
  }
  i = skipBracketWs(input, i);
  out.length = i - start;
  return out;
}

/** Parse edge name (and optional WHERE clause, `ORDER BY`/`LIMIT` trailing
 *  clauses, or `{ ... }` config object)
 *  inside -[:Name WHERE ...]-> / -[:`Quoted Name`]-> / -[#extract { ... }]-> */
function parseBracketContent(input: string, start: number): { name: string; filterText?: string; configText?: string; orderByText?: string; orderDirection?: 'asc' | 'desc'; limit?: number; length: number } | null {
  let i = start;
  // Skip whitespace
  i = skipBracketWs(input, i);

  if (i >= input.length) return null;

  let name: string;

  // Backtick-quoted name
  if (input[i] === '`') {
    i++;
    name = '';
    while (i < input.length && input[i] !== '`') {
      if (input[i] === '\\' && i + 1 < input.length) { name += input[++i]; }
      else { name += input[i]; }
      i++;
    }
    if (i < input.length) i++; // closing backtick
  } else {
    // Unquoted name — read until ], WHERE, ORDER BY/LIMIT, or `{` (config object)
    name = '';
    while (i < input.length && input[i] !== ']' && input[i] !== '\n' && input[i] !== '{') {
      // Check for WHERE / trailing-clause keywords
      if (input.slice(i).match(/^\s+WHERE\s/i)) {
        break;
      }
      if (BRACKET_TRAILING_CLAUSE.test(input.slice(i))) {
        break;
      }
      name += input[i]; i++;
    }
    name = name.trimEnd();
    if (!name) return null;
  }

  // Check for WHERE clause or `{` config object
  let filterText: string | undefined;
  let configText: string | undefined;
  i = skipBracketWs(input, i);
  if (i + 5 < input.length && input.slice(i, i + 5).toUpperCase() === 'WHERE' && /\s/.test(input[i + 5])) {
    i += 5; // skip WHERE
    i = skipBracketWs(input, i);
    const filterStart = i;
    // Read until the hop's closing ] or a top-level trailing clause
    // (ORDER BY / LIMIT). Track nested ( ) AND [ ] so a parenthesised
    // sub-expression or an array literal (`Status IN ["a", "b"]`) inside the
    // WHERE doesn't end the bracket early.
    let depth = 0;
    while (i < input.length) {
      if (input[i] === '(' || input[i] === '[') depth++;
      else if (input[i] === ')') depth--;
      else if (input[i] === ']') {
        if (depth === 0) break; // the hop's own closing bracket
        depth--; // a nested array literal's bracket
      }
      else if (depth === 0 && BRACKET_TRAILING_CLAUSE.test(input.slice(i))) break;
      else if (input[i] === '"' || input[i] === "'") {
        // Skip string literals
        const q = input[i]; i++;
        while (i < input.length && input[i] !== q) {
          if (input[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    filterText = input.slice(filterStart, i).trimEnd();
    if (!filterText) filterText = undefined;
  } else if (i < input.length && input[i] === '{') {
    // Config object: balanced `{ ... }`. Tracks string-literal boundaries
    // so a stray `{` / `}` inside a quoted value doesn't unbalance depth.
    const cfgStart = i + 1;
    let depth = 1;
    i++;
    while (i < input.length && depth > 0) {
      const ch = input[i];
      if (ch === '"' || ch === "'") {
        const q = ch; i++;
        while (i < input.length && input[i] !== q) {
          if (input[i] === '\\') i++;
          i++;
        }
        if (i < input.length) i++; // closing quote
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth === 0) break;
      i++;
    }
    configText = input.slice(cfgStart, i).trim();
    if (i < input.length && input[i] === '}') i++; // consume closing }
    i = skipBracketWs(input, i);
  }

  // Trailing `ORDER BY <prop> [ASC|DESC]` / `LIMIT <n>` clauses.
  const trailing = parseBracketOrderLimit(input, i);
  i += trailing.length;

  return {
    name,
    length: i - start,
    ...(filterText !== undefined ? { filterText } : {}),
    ...(configText !== undefined ? { configText } : {}),
    ...(trailing.orderByText !== undefined ? { orderByText: trailing.orderByText } : {}),
    ...(trailing.orderDirection !== undefined ? { orderDirection: trailing.orderDirection } : {}),
    ...(trailing.limit !== undefined ? { limit: trailing.limit } : {}),
  };
}

/**
 * Parse cypher-bracket interior with an optional alias prefix:
 *   `name:Edge` / `name:#extract { ... }` / `\`Quoted Name\`:Edge`
 * Returns null when no alias-colon pattern matches (caller falls
 * back to the legacy `:Name` / `#Name` paths).
 */
function parseAliasBracketContent(input: string, start: number):
  | { alias: string; rawName: string; filterText?: string; configText?: string; orderByText?: string; orderDirection?: 'asc' | 'desc'; limit?: number; length: number }
  | null {
  let i = start;
  i = skipBracketWs(input, i);
  if (i >= input.length) return null;

  let alias: string | undefined;
  let probe = i;
  if (input[probe] === '`') {
    probe++;
    let aliasName = '';
    while (probe < input.length && input[probe] !== '`') {
      if (input[probe] === '\\' && probe + 1 < input.length) { aliasName += input[++probe]; }
      else { aliasName += input[probe]; }
      probe++;
    }
    if (probe < input.length && input[probe] === '`') {
      probe++;
      probe = skipBracketWs(input, probe);
      if (input[probe] === ':') {
        alias = aliasName;
        i = probe + 1;
      }
    }
  } else if (/[a-zA-Z_]/.test(input[probe])) {
    let aliasName = '';
    while (probe < input.length && /[a-zA-Z0-9_]/.test(input[probe])) {
      aliasName += input[probe]; probe++;
    }
    let p2 = probe;
    p2 = skipBracketWs(input, p2);
    if (input[p2] === ':') {
      alias = aliasName;
      i = p2 + 1;
    }
  }

  if (alias === undefined) return null;

  i = skipBracketWs(input, i);
  const inner = parseBracketContent(input, i);
  if (!inner) return null;
  return {
    alias,
    rawName: inner.name,
    length: (i - start) + inner.length,
    ...(inner.filterText !== undefined ? { filterText: inner.filterText } : {}),
    ...(inner.configText !== undefined ? { configText: inner.configText } : {}),
    ...(inner.orderByText !== undefined ? { orderByText: inner.orderByText } : {}),
    ...(inner.orderDirection !== undefined ? { orderDirection: inner.orderDirection } : {}),
    ...(inner.limit !== undefined ? { limit: inner.limit } : {}),
  };
}

/**
 * The reserved resource-hop edge name. A `-[:_resources]->` / `-[a:_resources]->`
 * hop is the type's attached resource bundle, parsing to `resource_traverse`.
 * `_resources` is canonical: a leading-underscore identifier (no `#`), so it
 * parses everywhere an edge name can appear — the movement language treats a
 * leading `#` as a comment outside traversal brackets, which swallowed the older
 * `#resources` label. The underscore also marks it reserved/meta and keeps it
 * clear of extraction-derived names. `#resources` stays accepted as a deprecated
 * bracket-position alias for legacy expressions.
 *
 * The `:TYPE` shorthand (`_resources:TEXT`) is the part before the colon.
 */
export function isResourceHop(rawName: string): boolean {
  const base = rawName.split(/[:\s]/, 1)[0];
  return base === '_resources' || base === '#resources';
}

/**
 * The one escape rule for string literals, shared with the movement
 * bridge's interpolated-string desugar: `\n` / `\t` / `\r` translate to
 * their control characters; any other escaped character is itself
 * (`\"` a quote, `\\` a backslash, `\$` a literal dollar before `{`).
 */
export function translateStringEscape(next: string): string {
  switch (next) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    default:
      return next;
  }
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) { i++; continue; }

    const pos = i;

    // String literal
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      i++;
      let value = '';
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) { value += translateStringEscape(input[++i]); }
        else { value += input[i]; }
        i++;
      }
      if (i < input.length) i++; // closing quote
      tokens.push({ type: 'string', value, pos, end: i });
      continue;
    }

    // Backtick-quoted identifier
    if (input[i] === '`') {
      i++;
      let value = '';
      while (i < input.length && input[i] !== '`') {
        if (input[i] === '\\' && i + 1 < input.length) { value += input[++i]; }
        else { value += input[i]; }
        i++;
      }
      if (i < input.length) i++; // closing backtick
      tokens.push({ type: 'ident', value, pos, end: i });
      continue;
    }

    // Number
    if (/[0-9]/.test(input[i]) || (input[i] === '-' && i + 1 < input.length && /[0-9]/.test(input[i + 1]) && (tokens.length === 0 || tokens[tokens.length - 1].type === 'op' || tokens[tokens.length - 1].type === 'paren' || tokens[tokens.length - 1].type === 'comma'))) {
      let num = '';
      if (input[i] === '-') { num += input[i]; i++; }
      while (i < input.length && /[0-9.]/.test(input[i])) { num += input[i]; i++; }
      tokens.push({ type: 'number', value: num, pos, end: i });
      continue;
    }

    // @ special prefix
    if (input[i] === '@') {
      i++;
      let value = '@';
      while (i < input.length && /[a-zA-Z0-9_.]/.test(input[i])) { value += input[i]; i++; }
      tokens.push({ type: 'special', value, pos, end: i });
      continue;
    }

    // Cypher-like traversal arrows: -[:Name]-> / <-[:Name]- / -[:Name WHERE ...]->
    // Cypher-bracket alias form: -[name:Edge]-> / -[name:#extract { ... }]->
    // Special traversals: -[#resources...]-> / -[#linked...]->
    if (input[i] === '-' && input[i + 1] === '[') {
      // Try alias-bracket form first when the char after `[` isn't `:` or `#`.
      if (input[i + 2] !== ':' && input[i + 2] !== '#') {
        const aliased = parseAliasBracketContent(input, i + 2);
        if (aliased) {
          const afterContent = i + 2 + aliased.length;
          let end: number | null = null;
          if (input[afterContent] === ']' && input[afterContent + 1] === '-' && input[afterContent + 2] === '>') {
            end = afterContent + 3;
          } else if (input[afterContent] === ']' && input[afterContent + 1] === '-') {
            end = afterContent + 2;
          }
          if (end !== null) {
            const tok: Token = {
              type: 'traverse',
              value: aliased.rawName,
              pos,
              end,
              alias: aliased.alias,
              ...(aliased.filterText !== undefined ? { filterText: aliased.filterText } : {}),
              ...(aliased.configText !== undefined ? { configText: aliased.configText } : {}),
              ...(aliased.orderByText !== undefined ? { orderByText: aliased.orderByText } : {}),
              ...(aliased.orderDirection !== undefined ? { orderDirection: aliased.orderDirection } : {}),
              ...(aliased.limit !== undefined ? { limitCount: aliased.limit } : {}),
            };
            tokens.push(tok);
            i = end;
            continue;
          }
        }
      }
      if (input[i + 2] === ':' || input[i + 2] === '#') {
        // Legacy form: -[: or -[#
        const offset = input[i + 2] === ':' ? i + 3 : i + 2; // # is part of the name
        const content = parseBracketContent(input, offset);
        if (content) {
          const afterName = offset + content.length;
          let end: number | null = null;
          if (input[afterName] === ']' && input[afterName + 1] === '-' && input[afterName + 2] === '>') {
            end = afterName + 3;
          } else if (input[afterName] === ']' && input[afterName + 1] === '-') {
            end = afterName + 2;
          }
          if (end !== null) {
            const tok: Token = {
              type: 'traverse',
              value: content.name,
              pos,
              end,
              ...(content.filterText !== undefined ? { filterText: content.filterText } : {}),
              ...(content.configText !== undefined ? { configText: content.configText } : {}),
              ...(content.orderByText !== undefined ? { orderByText: content.orderByText } : {}),
              ...(content.orderDirection !== undefined ? { orderDirection: content.orderDirection } : {}),
              ...(content.limit !== undefined ? { limitCount: content.limit } : {}),
            };
            tokens.push(tok);
            i = end;
            continue;
          }
        }
      }
    }
    if (input[i] === '<' && input[i + 1] === '-' && input[i + 2] === '[' && input[i + 3] === ':') {
      // Incoming edge start: <-[:
      const content = parseBracketContent(input, i + 4);
      if (content) {
        const afterName = i + 4 + content.length;
        if (input[afterName] === ']' && input[afterName + 1] === '-') {
          tokens.push({
            type: 'traverse', value: '<' + content.name, pos, end: afterName + 2,
            filterText: content.filterText,
            ...(content.orderByText !== undefined ? { orderByText: content.orderByText } : {}),
            ...(content.orderDirection !== undefined ? { orderDirection: content.orderDirection } : {}),
            ...(content.limit !== undefined ? { limitCount: content.limit } : {}),
          });
          i = afterName + 2;
          continue;
        }
      }
    }

    // Multi-char operators
    if (input[i] === '!' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '!=', pos, end: i + 2 }); i += 2; continue;
    }
    // A lone `!` is TypeScript's spelling of NOT — the parser folds it into
    // the same `not` node, so `!x` and `NOT x` are one expression.
    if (input[i] === '!') {
      tokens.push({ type: 'keyword', value: 'NOT', pos, end: i + 1 }); i++; continue;
    }
    if (input[i] === '>' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '>=', pos, end: i + 2 }); i += 2; continue;
    }
    if (input[i] === '<' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '<=', pos, end: i + 2 }); i += 2; continue;
    }
    // `==` is a common alias for `=`. Without this, `==` tokenizes as
    // two separate `=` ops which breaks in-string enum completion (the
    // LHS lookup finds an op rather than the identifier).
    if (input[i] === '=' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '=', pos, end: i + 2 }); i += 2; continue;
    }

    // Single-char operators and parens
    if ('=><+-*/%'.includes(input[i])) {
      tokens.push({ type: 'op', value: input[i], pos, end: i + 1 }); i++; continue;
    }
    if ('(),'.includes(input[i])) {
      const t = input[i] === ',' ? 'comma' : 'paren';
      tokens.push({ type: t as Token['type'], value: input[i], pos, end: i + 1 }); i++; continue;
    }
    // List-literal and config-object delimiters (`[`, `]`, `{`, `}`, `:`)
    // — only emitted at the top level. Inside cypher brackets the
    // brace pair is consumed by parseBracketContent before tokenize sees it.
    if (input[i] === '[') { tokens.push({ type: 'lbracket', value: '[', pos, end: i + 1 }); i++; continue; }
    if (input[i] === ']') { tokens.push({ type: 'rbracket', value: ']', pos, end: i + 1 }); i++; continue; }
    if (input[i] === '{') { tokens.push({ type: 'lbrace', value: '{', pos, end: i + 1 }); i++; continue; }
    if (input[i] === '}') { tokens.push({ type: 'rbrace', value: '}', pos, end: i + 1 }); i++; continue; }
    if (input[i] === ':') { tokens.push({ type: 'colon', value: ':', pos, end: i + 1 }); i++; continue; }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(input[i])) {
      let value = '';
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) { value += input[i]; i++; }
      const upper = value.toUpperCase();
      if (KEYWORDS.has(upper)) {
        tokens.push({ type: 'keyword', value: upper, pos, end: i });
      } else {
        tokens.push({ type: 'ident', value, pos, end: i });
      }
      continue;
    }

    // `...` — a list literal's spread. One token, so the parser never has to
    // reassemble it from three dots.
    if (input[i] === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ type: 'spread', value: '...', pos, end: i + 3 }); i += 3; continue;
    }

    // Dot (for edge. prefix etc)
    if (input[i] === '.') {
      tokens.push({ type: 'op', value: '.', pos, end: i + 1 }); i++; continue;
    }

    // Anything else has no meaning here. It is kept as a token rather than
    // skipped — a dropped character silently changes what the expression
    // says (a skipped `!` inverted a condition) — and the parser refuses it.
    // Completion tokenizes half-typed text too, so the refusal belongs to the
    // parser, not here.
    tokens.push({ type: 'unknown', value: input[i], pos, end: i + 1 }); i++;
  }

  tokens.push({ type: 'eof', value: '', pos: input.length, end: input.length });
  return tokens;
}

/** The aggregate function names, and the AST kind each reads as. */
export const AGG_FNS: Record<string, string> = {
  FIRST: 'first', LAST: 'last', ONLY: 'only', COUNT: 'count', SUM: 'sum', AVG: 'avg',
  MIN: 'min', MAX: 'max', JOIN: 'join', COLLECT: 'collect', LLM_AGG: 'llm',
};

/**
 * Every function name this grammar reads as something OTHER than a generic
 * call — the aggregates and the special forms `parseFunctionCall` (and
 * `SORT`'s own reader) recognise. Upper-case, as the grammar compares them.
 * Exported so a caller that has to tell a built-in call from some other
 * invocation of the same shape compares against the grammar's own list.
 */
export const FORMULA_SPECIAL_FUNCTIONS: ReadonlySet<string> = new Set([
  ...Object.keys(AGG_FNS),
  'AI', 'CONCAT', 'KG_EXISTS', 'KG_VALUE', 'EXTRACT_VALUE', 'AT', 'SORT',
]);

// ── Context-aware completions ──

export type CompletionKind = 'value' | 'option' | 'operator' | 'keyword' | 'function' | 'edge' | 'special';

export interface Completion {
  label: string;
  insert: string;
  kind: CompletionKind;
}

const FUNCTION_COMPLETIONS: Completion[] = [
  { label: 'IF', insert: 'IF', kind: 'keyword' },
  { label: 'NOT', insert: 'NOT', kind: 'keyword' },
  { label: 'CONCAT()', insert: 'CONCAT(', kind: 'function' },
  { label: 'COALESCE()', insert: 'COALESCE(', kind: 'function' },
  { label: 'AI()', insert: 'AI(', kind: 'function' },
  { label: 'FIRST()', insert: 'FIRST(', kind: 'function' },
  { label: 'LAST()', insert: 'LAST(', kind: 'function' },
  { label: 'COUNT()', insert: 'COUNT(', kind: 'function' },
  { label: 'SUM()', insert: 'SUM(', kind: 'function' },
  { label: 'AVG()', insert: 'AVG(', kind: 'function' },
  { label: 'MIN()', insert: 'MIN(', kind: 'function' },
  { label: 'MAX()', insert: 'MAX(', kind: 'function' },
  { label: 'JOIN()', insert: 'JOIN(', kind: 'function' },
  { label: 'ONLY()', insert: 'ONLY(', kind: 'function' },
  { label: 'MULTI()', insert: 'MULTI(', kind: 'function' },
  { label: 'SPLIT()', insert: 'SPLIT(', kind: 'function' },
  { label: 'KG_EXISTS()', insert: 'KG_EXISTS(', kind: 'function' },
  { label: 'KG_VALUE()', insert: 'KG_VALUE(', kind: 'function' },
  // WITHIN(<date field>, "<interval>") — temporal scope predicate, used
  // in uniqueness constraints to express recency windows. Gated to
  // contexts with a date field (see `getCompletions`).
  { label: 'WITHIN()', insert: 'WITHIN(', kind: 'function' },
];

const SPECIAL_COMPLETIONS: Completion[] = [
  { label: '@id', insert: '@id', kind: 'special' },
  { label: '@user_name', insert: '@user_name', kind: 'special' },
  { label: '@user_email', insert: '@user_email', kind: 'special' },
  { label: '@current_date', insert: '@current_date', kind: 'special' },
  { label: '@input_channel_name', insert: '@input_channel_name', kind: 'special' },
  { label: '@parent.created', insert: '@parent.created', kind: 'special' },
  { label: '@parent.external_id', insert: '@parent.external_id', kind: 'special' },
];

// Operators grouped by what types they're valid for
const TEXT_OPS: Completion[] = [
  { label: '=', insert: '=', kind: 'operator' },
  { label: '!=', insert: '!=', kind: 'operator' },
  { label: 'contains', insert: 'contains', kind: 'operator' },
  { label: 'in', insert: 'in', kind: 'operator' },
];
const NUMERIC_OPS: Completion[] = [
  { label: '=', insert: '=', kind: 'operator' },
  { label: '!=', insert: '!=', kind: 'operator' },
  { label: '>', insert: '>', kind: 'operator' },
  { label: '>=', insert: '>=', kind: 'operator' },
  { label: '<', insert: '<', kind: 'operator' },
  { label: '<=', insert: '<=', kind: 'operator' },
  { label: '+', insert: '+', kind: 'operator' },
  { label: '-', insert: '-', kind: 'operator' },
  { label: '*', insert: '*', kind: 'operator' },
  { label: '/', insert: '/', kind: 'operator' },
  { label: '%', insert: '%', kind: 'operator' },
];
const BOOLEAN_OPS: Completion[] = [
  { label: '=', insert: '=', kind: 'operator' },
  { label: '!=', insert: '!=', kind: 'operator' },
];
const ALL_OPS: Completion[] = [
  { label: '=', insert: '=', kind: 'operator' },
  { label: '!=', insert: '!=', kind: 'operator' },
  { label: '>', insert: '>', kind: 'operator' },
  { label: '>=', insert: '>=', kind: 'operator' },
  { label: '<', insert: '<', kind: 'operator' },
  { label: '<=', insert: '<=', kind: 'operator' },
  { label: 'contains', insert: 'contains', kind: 'operator' },
  { label: 'exists', insert: 'exists', kind: 'operator' },
  { label: 'in', insert: 'in', kind: 'operator' },
  { label: '+', insert: '+', kind: 'operator' },
  { label: '-', insert: '-', kind: 'operator' },
  { label: '*', insert: '*', kind: 'operator' },
  { label: '/', insert: '/', kind: 'operator' },
  { label: '%', insert: '%', kind: 'operator' },
];
const LOGICAL_OPS: Completion[] = [
  { label: 'AND', insert: 'AND', kind: 'keyword' },
  { label: 'OR', insert: 'OR', kind: 'keyword' },
];

const IF_BRANCH_COMPLETIONS: Completion[] = [
  { label: 'ELSE', insert: 'ELSE', kind: 'keyword' },
  { label: 'ELSE IF', insert: 'ELSE IF', kind: 'keyword' },
  { label: 'END', insert: 'END', kind: 'keyword' },
];

function opsForValueType(valueType?: string): Completion[] {
  if (!valueType) return ALL_OPS;
  switch (valueType) {
    case 'text': case 'enum': return TEXT_OPS;
    case 'number': case 'integer': case 'float': case 'currency': return NUMERIC_OPS;
    case 'boolean': return BOOLEAN_OPS;
    case 'date': case 'datetime': return NUMERIC_OPS; // dates compare with >, <, =
    default: return ALL_OPS;
  }
}

/** Check if cursor is inside an unclosed string literal */
function isInsideString(text: string, cursorPos: number): { quote: string; start: number } | null {
  let inString = false;
  let quote = '';
  let start = 0;
  for (let i = 0; i < cursorPos && i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; } // skip escaped char
      if (ch === quote) { inString = false; }
    } else {
      if (ch === '"' || ch === "'") { inString = true; quote = ch; start = i; }
    }
  }
  return inString ? { quote, start } : null;
}

/**
 * Detect if the cursor is inside an unclosed traversal bracket.
 * Returns the WHERE clause text before cursor and the edge name if found.
 * e.g. for `-[:Invested In WHERE Wei|` → { edgeName: 'Invested In', whereText: 'Wei', incoming: false }
 * Also handles special brackets: `-[#linked WHERE |` and `-[#resources WHERE |`
 */
function insideTraversalWhere(text: string): { edgeName: string; whereText: string; incoming: boolean; needsWhere?: boolean } | null {
  // Find the last unclosed -[: or -[# or <-[: pattern
  let lastBracketOpen = -1;
  let incoming = false;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ']') return null; // bracket was closed before cursor
    if (text[i] === '[' && i > 0 && text[i - 1] === '-') {
      if (i >= 2 && text[i - 2] === '<') {
        lastBracketOpen = i;
        incoming = true;
      } else {
        lastBracketOpen = i;
        incoming = false;
      }
      break;
    }
  }
  if (lastBracketOpen === -1) return null;

  const inside = text.slice(lastBracketOpen + 1); // content after [
  let afterPrefix: string;
  if (inside.startsWith(':')) {
    afterPrefix = inside.slice(1);
  } else if (inside.startsWith('#')) {
    afterPrefix = inside;
  } else {
    return null;
  }

  // Check for WHERE
  const whereMatch = afterPrefix.match(/^(.+?)\s+WHERE\s+(.*)/i);
  if (whereMatch) {
    let edgeName = whereMatch[1].trim();
    if (edgeName.startsWith('`') && edgeName.endsWith('`')) {
      edgeName = edgeName.slice(1, -1);
    }
    return { edgeName, whereText: whereMatch[2], incoming };
  }

  // Inside a special bracket after the name but before WHERE (e.g. `-[#linked |`)
  if (inside.startsWith('#')) {
    const nameMatch = afterPrefix.match(/^(#\w+)\s+(.*)/);
    if (nameMatch) {
      // Check if the text after the name starts with partial/full WHERE or is empty
      const rest = nameMatch[2];
      const hasWhere = /^WHERE\s/i.test(rest);
      if (hasWhere) {
        // Already typed WHERE, skip to the clause
        const whereContent = rest.replace(/^WHERE\s+/i, '');
        return { edgeName: nameMatch[1], whereText: whereContent, incoming };
      }
      return { edgeName: nameMatch[1], whereText: rest, incoming, needsWhere: true };
    }
  }

  return null;
}

/**
 * Walk traverse tokens to determine the node type at the cursor — and
 * the last edge type stepped through within the current scope, used to
 * scope `edge.X` completions to the just-walked edge's properties.
 *
 * Tracks paren nesting so that commas and operators reset context to the
 * enclosing scope — a traversal only shifts context within its sub-expression,
 * not across sibling arguments or subsequent binary operations. `lastEdgeId`
 * follows the same scoping discipline: leaving a traversal sub-expression
 * (via comma, op, paren, AND/OR/…) clears it.
 */
function resolveTraversalContext(
  toks: Token[],
  startNodeTypeId: string | undefined,
  allEdges: EdgeInfo[],
): { nodeTypeId: string | undefined; lastEdgeId: string | undefined } {
  type Frame = { node: string | undefined; edge: string | undefined };
  let nodeTypeId = startNodeTypeId;
  let lastEdgeId: string | undefined;
  const parenStack: Frame[] = [];

  function scopeContext(): Frame {
    return parenStack.length > 0
      ? parenStack[parenStack.length - 1]
      : { node: startNodeTypeId, edge: undefined };
  }

  for (const t of toks) {
    if (t.type === 'paren' && t.value === '(') {
      parenStack.push({ node: nodeTypeId, edge: lastEdgeId });
    } else if (t.type === 'paren' && t.value === ')') {
      const pop = parenStack.length > 0
        ? parenStack.pop()!
        : { node: startNodeTypeId, edge: undefined };
      nodeTypeId = pop.node;
      lastEdgeId = pop.edge;
    } else if (t.type === 'comma') {
      const s = scopeContext();
      nodeTypeId = s.node;
      lastEdgeId = s.edge;
    } else if (t.type === 'op' && t.value !== '.') {
      const s = scopeContext();
      nodeTypeId = s.node;
      lastEdgeId = s.edge;
    } else if (t.type === 'keyword' && (t.value === 'AND' || t.value === 'OR' || t.value === 'THEN' || t.value === 'ELSE')) {
      const s = scopeContext();
      nodeTypeId = s.node;
      lastEdgeId = s.edge;
    } else if (t.type === 'traverse') {
      if (!nodeTypeId) continue;
      const incoming = t.value.startsWith('<');
      const edgeName = incoming ? t.value.slice(1) : t.value;
      const lower = edgeName.toLowerCase();
      const outMatch = allEdges.find(e => e.outboundName.toLowerCase() === lower);
      if (outMatch) {
        nodeTypeId = outMatch.targetNodeTypeId;
        lastEdgeId = outMatch.id;
        continue;
      }
      const inMatch = allEdges.find(e => e.inboundName.toLowerCase() === lower);
      if (inMatch) {
        nodeTypeId = inMatch.sourceNodeTypeId;
        lastEdgeId = inMatch.id;
        continue;
      }
      nodeTypeId = undefined;
      lastEdgeId = undefined;
    }
  }
  return { nodeTypeId, lastEdgeId };
}

export function propsForNodeType(allProperties: PropertyInfo[], nodeTypeId: string | undefined): PropertyInfo[] {
  if (!nodeTypeId) return allProperties;
  return allProperties.filter(p => !p.nodeTypeId || p.nodeTypeId === nodeTypeId);
}

function edgesForNodeType(allEdges: EdgeInfo[], nodeTypeId: string | undefined): EdgeInfo[] {
  if (!nodeTypeId) return allEdges;
  return allEdges.filter(e =>
    e.sourceNodeTypeId === nodeTypeId || e.targetNodeTypeId === nodeTypeId,
  );
}

const RESOURCE_FIELD_COMPLETIONS: Completion[] = [
  { label: 'content', insert: '.content', kind: 'value' },
  { label: 'name', insert: '.name', kind: 'value' },
  { label: 'url', insert: '.url', kind: 'value' },
  { label: 'type', insert: '.type', kind: 'value' },
  { label: 'document_url', insert: '.document_url', kind: 'value' },
];

const SPECIAL_TRAVERSE_COMPLETIONS: Completion[] = [
  { label: '-[:_resources]->', insert: '-[:_resources]->', kind: 'edge' },
  { label: '-[#linked]->', insert: '-[#linked]->', kind: 'edge' },
];

const LINKED_FIELD_COMPLETIONS: Completion[] = [
  { label: 'external_id', insert: '.external_id', kind: 'value' },
  { label: 'url', insert: '.url', kind: 'value' },
  { label: 'name', insert: '.name', kind: 'value' },
  { label: 'external_object_type', insert: '.external_object_type', kind: 'value' },
];

// Properties available inside WHERE for special traversal brackets
const LINKED_WHERE_PROPERTIES: PropertyInfo[] = [
  { id: 'type', name: 'type', valueType: 'text' },
];
const RESOURCE_WHERE_PROPERTIES: PropertyInfo[] = [
  { id: 'type', name: 'type', valueType: 'text' },
  { id: 'hasDocument', name: 'hasDocument', valueType: 'boolean' },
  { id: 'mimeType', name: 'mimeType', valueType: 'text' },
  { id: 'namePattern', name: 'namePattern', valueType: 'text' },
];

function edgeCompletionsFor(
  edges: EdgeInfo[],
  nodeTypeId: string | undefined,
  capabilities: FormulaCapabilities = DEFAULT_CAPABILITIES,
): Completion[] {
  const results = edges.flatMap(e => {
    const items: Completion[] = [];
    // Outgoing from this node type: show outbound name
    if (!nodeTypeId || e.sourceNodeTypeId === nodeTypeId) {
      const outName = needsQuote(e.outboundName) ? '`' + e.outboundName + '`' : e.outboundName;
      items.push({ label: `-[:${e.outboundName}]->`, insert: `-[:${outName}]->`, kind: 'edge' });
    }
    // Incoming to this node type: display as outgoing with inbound name.
    // Gated on incomingEdges capability — external adapters typically can't
    // walk a reference in reverse (their references are unidirectional).
    if (capabilities.incomingEdges && (!nodeTypeId || e.targetNodeTypeId === nodeTypeId)) {
      const inName = needsQuote(e.inboundName) ? '`' + e.inboundName + '`' : e.inboundName;
      items.push({ label: `-[:${e.inboundName}]->`, insert: `-[:${inName}]->`, kind: 'edge' });
    }
    return items;
  });
  const special: Completion[] = [];
  if (capabilities.resources) special.push(SPECIAL_TRAVERSE_COMPLETIONS[0]); // -[#resources]->
  if (capabilities.linkedObjects) special.push(SPECIAL_TRAVERSE_COMPLETIONS[1]); // -[#linked]->
  return [...results, ...special];
}

/**
 * TG-mode completion options. When `tgMode` is on, the completion engine
 * surfaces additional tokens that only make sense in a translation-graph
 * authoring context:
 *
 *  - `triggerAliases` are the bare-name handles bound further up the
 *    action subtree (and at the trigger root, e.g. `msg` for
 *    `trigger: slack_message AS msg`). They appear as value-position
 *    completions; descendants reference them by bare name.
 *  - `insideExtract`: when the current authoring position is descended
 *    from an ancestral `#extract` meta-edge, `EXTRACT_VALUE()` is offered
 *    as a function completion. Outside an `#extract`, the call would
 *    fail TG validation, so we hide it from the dropdown.
 *  - Cypher-syntax hint completions are always-on under tgMode, since
 *    those are TG-only grammar.
 *
 * See `plans/2026-05-19-tg-extraction-parity/expression_syntax.md`.
 */
/**
 * An adapter-provided field function offered on the field currently being
 * mapped (e.g. Slack's `SLACK_MESSAGE`). Surfaced in the completion dropdown
 * and the argument-hint tooltip ONLY for that field — discoverability is
 * field-scoped (P4). Mirrors the api-side `FieldFunctionDescriptor` but kept
 * structural here so the shared package doesn't depend on api types.
 *
 */
export interface FieldFunctionInfo {
  name: string;
  summary?: string;
  params?: readonly { name: string; doc?: string; variadic?: boolean }[];
}

export interface TgCompletionOptions {
  /** Aliases visible at the current authoring position (ancestor + trigger). */
  triggerAliases?: readonly string[];
  /** Whether the current authoring position is inside an `#extract`
   *  ancestor — gates the EXTRACT_VALUE() completion. */
  insideExtract?: boolean;
  /** Functions the target field being mapped advertises — added to the
   *  function completions for this field only. */
  fieldFunctions?: readonly FieldFunctionInfo[];
}

const EXTRACT_VALUE_COMPLETION: Completion = {
  label: 'EXTRACT_VALUE()',
  insert: 'EXTRACT_VALUE(',
  kind: 'function',
};

// Cypher-syntax templates surfaced after a `-` trailing in TG mode, so
// authors discover the bracket-binding and meta-edge config-object
// grammar without having to remember the punctuation.
const CYPHER_SYNTAX_COMPLETIONS: Completion[] = [
  { label: '-[name:Edge]->', insert: '-[', kind: 'edge' },
  { label: '-[#extract { description: "…", data: [...] }]->', insert: '-[#extract { description: "', kind: 'edge' },
  { label: '-[#transform { plugin: "…" }]->', insert: '-[#transform { plugin: "', kind: 'edge' },
];

// Inside a meta-edge bracket (after `-[#extract` / `-[#transform`), the
// allowed config keys are deterministic — surface them so authors don't
// have to recall the schema. Keyed by metaEdge kind.
const META_EDGE_CONFIG_KEYS: Record<string, Completion[]> = {
  '#extract': [
    { label: 'description:', insert: 'description: "', kind: 'keyword' },
    { label: 'data:', insert: 'data: [', kind: 'keyword' },
  ],
  '#transform': [
    { label: 'plugin:', insert: 'plugin: "', kind: 'keyword' },
    { label: 'config:', insert: 'config: { ', kind: 'keyword' },
  ],
};

/** Detect if the cursor sits inside an open `-[#extract` / `-[#transform`
 *  bracket but BEFORE the closing `]`. Used in TG-mode autocomplete to
 *  surface config-object key hints. Returns the meta-edge kind, the raw
 *  inside text, and whether a `{` has already been opened. */
function insideMetaEdgeBracket(
  text: string,
): { metaEdge: '#extract' | '#transform' | '#resources'; inside: string; inConfig: boolean } | null {
  let lastOpen = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ']') return null;
    if (text[i] === '[' && i > 0 && text[i - 1] === '-') {
      lastOpen = i;
      break;
    }
  }
  if (lastOpen === -1) return null;
  const inside = text.slice(lastOpen + 1);
  // Must start with `#` (meta-edge) — schema edges (`:Foo`) and bare aliases (`name:Edge`) don't apply.
  const metaMatch = inside.match(/^(#\w+)/);
  if (!metaMatch) {
    // Alias-bracket `name:#extract` form
    const aliasMeta = inside.match(/^[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*(#\w+)/);
    if (!aliasMeta) return null;
    const kind = aliasMeta[1] as '#extract' | '#transform' | '#resources';
    if (kind !== '#extract' && kind !== '#transform' && kind !== '#resources') return null;
    const inConfig = inside.includes('{');
    return { metaEdge: kind, inside, inConfig };
  }
  const kind = metaMatch[1] as '#extract' | '#transform' | '#resources';
  if (kind !== '#extract' && kind !== '#transform' && kind !== '#resources') return null;
  const inConfig = inside.includes('{');
  return { metaEdge: kind, inside, inConfig };
}

/**
 * Given the current text and cursor position, determine what completions to offer.
 * Uses a lightweight heuristic: look at the tokens before the cursor.
 *
 * @param contextNodeTypeId - The starting node type for this expression context.
 *   After traversals, the effective node type shifts to the far end of the edge,
 *   changing which properties and edges are offered.
 * @param tgOptions - Optional TG-mode completion config (alias bindings + `#extract`
 *   scope). When omitted, behavior is identical to legacy non-TG mode.
 */
export function getCompletions(
  input: string,
  cursorPos: number,
  properties: PropertyInfo[],
  edges?: EdgeInfo[],
  contextNodeTypeId?: string,
  edgeProperties?: PropertyInfo[],
  outputConstraints?: string[],
  capabilities: FormulaCapabilities = DEFAULT_CAPABILITIES,
  tgOptions?: TgCompletionOptions,
): Completion[] {
  // Inside a string literal: offer enum/output-constraint completions with bare insert text
  const stringCtx = isInsideString(input, cursorPos);
  if (stringCtx) {
    const partial = input.slice(stringCtx.start + 1, cursorPos);
    const inStringCompletions: Completion[] = [];

    // Determine which properties/edges to check for enum values by analyzing
    // the text before the string (i.e., the LHS property and operator)
    const textBeforeString = input.slice(0, stringCtx.start);
    const preToks = tokenize(textBeforeString).filter(t => t.type !== 'eof');

    // Check for enum values from the LHS property of a comparison
    const lastPreTok = preToks[preToks.length - 1];
    if (lastPreTok && (lastPreTok.type === 'op' || (lastPreTok.type === 'keyword' && COMPARE_KEYWORDS.has(lastPreTok.value)))) {
      const lhsTok = findTokenBefore(preToks, lastPreTok);
      if (lhsTok?.type === 'ident') {
        // Try main properties first, then edge properties (for WHERE clauses)
        const allProps = [...properties, ...(edgeProperties ?? [])];
        const lhsProp = allProps.find(p => p.name.toLowerCase() === lhsTok.value.toLowerCase());
        if (lhsProp?.enumValues) {
          for (const v of lhsProp.enumValues) {
            const escaped = stringCtx.quote === "'" ? v.replace(/'/g, "\\'") : v.replace(/"/g, '\\"');
            // Render as 'option' to match the styling used for output
            // constraints — they're conceptually the same: a closed set
            // of valid values for the current expression position.
            inStringCompletions.push({ label: v, insert: escaped + stringCtx.quote, kind: 'option' });
          }
        }
      }
    }

    // Output constraint completions (Airtable select options etc.)
    if (outputConstraints && outputConstraints.length > 0) {
      for (const v of outputConstraints) {
        const escaped = stringCtx.quote === "'" ? v.replace(/'/g, "\\'") : v.replace(/"/g, '\\"');
        inStringCompletions.push({ label: v, insert: escaped + stringCtx.quote, kind: 'option' });
      }
    }

    return filterCompletions(inStringCompletions, partial);
  }

  const textBefore = input.slice(0, cursorPos);

  // Check if cursor is inside a WHERE clause within traversal brackets
  const whereCtx = insideTraversalWhere(textBefore);
  if (whereCtx) {
    // Before WHERE keyword — suggest WHERE
    if (whereCtx.needsWhere) {
      const partial = getLastWord(whereCtx.whereText);
      return filterCompletions([{ label: 'WHERE', insert: 'WHERE ', kind: 'keyword' }], partial);
    }

    // For special brackets, use dedicated property lists
    const epList = whereCtx.edgeName === '#linked' ? LINKED_WHERE_PROPERTIES
      : isResourceHop(whereCtx.edgeName) ? RESOURCE_WHERE_PROPERTIES
      : (edgeProperties ?? []);
    // Inside WHERE: offer edge properties + operators + logical keywords
    const whereTokens = tokenize(whereCtx.whereText);
    const whereToks = whereTokens.filter(t => t.type !== 'eof');
    const whereLastWord = getLastWord(whereCtx.whereText);
    const whereLastTok = whereToks[whereToks.length - 1];

    const isWhereValueExpecting = (t: Token | undefined) =>
      !t || t.type === 'op' || t.type === 'comma' ||
      (t.type === 'keyword' && ['AND', 'OR', 'NOT'].includes(t.value));

    const wherePrevTok = whereToks.length >= 2 ? whereToks[whereToks.length - 2] : undefined;
    const whereMidTyping = whereLastWord !== '' && whereLastTok?.type === 'ident' &&
      (whereToks.length === 1 || isWhereValueExpecting(wherePrevTok));

    if (isWhereValueExpecting(whereLastTok) || whereMidTyping) {
      const epCompletions: Completion[] = epList.map(p => ({
        label: p.name,
        insert: needsQuote(p.name) ? '`' + p.name + '`' : p.name,
        kind: 'value' as const,
      }));
      // Comparison RHS enum hints for WHERE clause
      const whereEnumCompletions: Completion[] = [];
      const whereOpTok = whereMidTyping ? wherePrevTok : whereLastTok;
      if (whereOpTok && (whereOpTok.type === 'op' || (whereOpTok.type === 'keyword' && COMPARE_KEYWORDS.has(whereOpTok.value)))) {
        const whereLhsTok = findTokenBefore(whereToks, whereOpTok);
        if (whereLhsTok?.type === 'ident') {
          const lhsProp = epList.find(p => p.name.toLowerCase() === whereLhsTok.value.toLowerCase());
          if (lhsProp?.enumValues) {
            for (const v of lhsProp.enumValues) {
              whereEnumCompletions.push({ label: v, insert: `'${v.replace(/'/g, "\\'")}'`, kind: 'value' });
            }
          }
        }
      }
      return filterCompletions([...epCompletions, ...whereEnumCompletions], whereLastWord);
    }

    const afterWhereValue =
      whereLastTok?.type === 'ident' || whereLastTok?.type === 'string' ||
      whereLastTok?.type === 'number' ||
      (whereLastTok?.type === 'keyword' && ['TRUE', 'FALSE', 'NULL'].includes(whereLastTok.value));

    if (afterWhereValue) {
      let valueType: string | undefined;
      if (whereLastTok?.type === 'ident') {
        const ep = epList.find(p => p.name.toLowerCase() === whereLastTok.value.toLowerCase());
        valueType = ep?.valueType;
      }
      return filterCompletions([...opsForValueType(valueType), ...LOGICAL_OPS], whereLastWord);
    }

    return [];
  }

  // TG-mode early check: cursor inside an open meta-edge bracket — surface
  // config-object key hints (`description:`, `data:`, `plugin:`) so authors
  // don't have to memorise the bracket schema. The cypher-bracket parser
  // accepts these keys in any order; this is purely a discoverability
  // affordance.
  if (tgOptions) {
    const metaBracket = insideMetaEdgeBracket(textBefore);
    if (metaBracket && metaBracket.inConfig && metaBracket.metaEdge !== '#resources') {
      // Only suggest at the start of a new key — `{` open, `,` separator,
      // or empty trailing whitespace inside the config object.
      const tail = metaBracket.inside.match(/[{,]\s*([a-zA-Z_]\w*)?$/);
      if (tail) {
        const partial = tail[1] ?? '';
        const keys = META_EDGE_CONFIG_KEYS[metaBracket.metaEdge] ?? [];
        return filterCompletions(keys, partial);
      }
    }
  }

  // Early check: incomplete traversal syntax at the end of input (-[, -[:, -[:partial)
  // Must come before tokenization since the tokenizer can't produce useful tokens from this.
  const incompleteTraversal = textBefore.match(/(<)?-\[(?::([^\]]*))?$/);
  if (incompleteTraversal) {
    // Tokenize everything before the incomplete traversal for context
    const cleanText = textBefore.slice(0, textBefore.length - incompleteTraversal[0].length);
    const preToks = tokenize(cleanText).filter(t => t.type !== 'eof');
    const allEdges = edges ?? [];
    const { nodeTypeId: effectiveNodeType } = resolveTraversalContext(preToks, contextNodeTypeId, allEdges);
    const contextEdges = edgesForNodeType(allEdges, effectiveNodeType);
    const partial = (incompleteTraversal[2] ?? '').replace(/^`/, '');
    return filterCompletions(edgeCompletionsFor(contextEdges, effectiveNodeType, capabilities), partial);
  }

  // Early check: typing @ prefix for special completions. Gated on the
  // `kgGlobals` capability — adapter-source authoring contexts (e.g.
  // trigger filters) have no parent action node or KG identifiers in
  // scope, so offering @parent / @id / @user_* would mislead.
  const specialPrefix = textBefore.match(/@([a-zA-Z0-9_.]*)?$/);
  if (specialPrefix) {
    if (capabilities.kgGlobals === false) return [];
    const partial = specialPrefix[0]; // includes the @
    return filterCompletions(SPECIAL_COMPLETIONS, partial);
  }

  const tokens = tokenize(textBefore);
  const toks = tokens.filter(t => t.type !== 'eof');
  const allEdges = edges ?? [];

  const lastWord = getLastWord(textBefore);
  // Raw trailing text for filtering when lastWord is empty. Only useful
  // when the user has typed traversal-start chars (`-`, `<`) without
  // any word chars yet, so completions like `-[:Foo]->` filter by `-`.
  // After fully-tokenized operators (`.`, `,`, `(`, `)`, etc.) the
  // cursor is at a fresh value position with no partial — falling back
  // to `getTrailingNonWhitespace` here would capture garbage like
  // `Of]->.` from a preceding traversal token and over-filter.
  const trailingChar = textBefore.slice(-1);
  const trailingRaw = lastWord || (trailingChar === '-' || trailingChar === '<'
    ? getTrailingNonWhitespace(textBefore)
    : '');
  const lastTok = toks[toks.length - 1];

  // Walk traversals to determine effective node type at cursor, and the
  // last edge stepped through (whose properties become accessible via
  // `edge.<prop>` per Cypher-style binding).
  const { nodeTypeId: effectiveNodeType, lastEdgeId } =
    resolveTraversalContext(toks, contextNodeTypeId, allEdges);
  const contextProps = propsForNodeType(properties, effectiveNodeType);
  const contextEdges = edgesForNodeType(allEdges, effectiveNodeType);
  const scopedEdgeProps = (edgeProperties ?? []).filter(
    p => lastEdgeId !== undefined && p.edgeTypeId === lastEdgeId,
  );

  // Count open IF/END to know if we're inside a conditional
  let ifDepth = 0;
  for (const t of toks) {
    if (t.type === 'keyword' && t.value === 'IF') ifDepth++;
    if (t.type === 'keyword' && t.value === 'END') ifDepth--;
  }

  // Check if a token indicates what follows should be a value
  const isValueExpecting = (t: Token | undefined) =>
    !t ||
    t.type === 'op' ||
    t.type === 'comma' ||
    (t.type === 'paren' && t.value === '(') ||
    (t.type === 'keyword' && ['AND', 'OR', 'NOT', 'THEN', 'ELSE', 'IF'].includes(t.value));

  // If currently typing an ident, check the token before it for context
  const prevTok = toks.length >= 2 ? toks[toks.length - 2] : undefined;
  const midTypingValue = lastWord !== '' && lastTok?.type === 'ident' && (toks.length === 1 || isValueExpecting(prevTok));

  const expectsValue = isValueExpecting(lastTok) || midTypingValue;

  // Inside `edge.<partial>` after a traversal — short-circuit to bare
  // edge-property names. The parser binds the just-walked edge as an
  // implicit `edge` variable (formula.ts:914-922 → edge_property AST);
  // the engine consumes it via ctx.lastEdges (expression.ts:236).
  // Only meaningful when the current scope has actually walked an edge,
  // and the adapter advertises the edgeProperties capability.
  const edgeAccessor = (() => {
    if (toks.length >= 2 &&
        lastTok?.type === 'op' && lastTok.value === '.' &&
        toks[toks.length - 2]!.type === 'ident' &&
        toks[toks.length - 2]!.value.toLowerCase() === 'edge') {
      return { partial: '' };
    }
    if (toks.length >= 3 &&
        lastTok?.type === 'ident' &&
        toks[toks.length - 2]!.type === 'op' &&
        toks[toks.length - 2]!.value === '.' &&
        toks[toks.length - 3]!.type === 'ident' &&
        toks[toks.length - 3]!.value.toLowerCase() === 'edge') {
      return { partial: lastTok.value };
    }
    return null;
  })();
  if (edgeAccessor) {
    if (!capabilities.edgeProperties || !lastEdgeId || scopedEdgeProps.length === 0) {
      return [];
    }
    return filterCompletions(
      scopedEdgeProps.map(p => ({
        label: p.name,
        insert: needsQuote(p.name) ? '`' + p.name + '`' : p.name,
        kind: 'value' as const,
      })),
      edgeAccessor.partial,
    );
  }

  // Build `edge.<prop>` completions for the just-walked edge — surfaced
  // in value-expecting and post-traversal branches below so users
  // discover the binding without having to type `edge.` first. Gated on
  // the adapter's `edgeProperties` capability + an in-scope traversal.
  const edgeBindCompletions: Completion[] = (capabilities.edgeProperties && lastEdgeId)
    ? scopedEdgeProps.map(p => {
        const q = needsQuote(p.name) ? '`' + p.name + '`' : p.name;
        return { label: `edge.${p.name}`, insert: `edge.${q}`, kind: 'value' as const };
      })
    : [];

  if (expectsValue) {
    const propCompletions: Completion[] = contextProps.map(p => ({
      label: p.name,
      insert: needsQuote(p.name) ? '`' + p.name + '`' : p.name,
      kind: 'value' as const,
    }));

    // TG-mode value-expecting additions: bare alias bindings (named
    // ancestors and trigger-root aliases) + EXTRACT_VALUE() — the
    // latter only when an ancestral `#extract` is in scope.
    const tgValueCompletions: Completion[] = [];
    if (tgOptions) {
      for (const alias of tgOptions.triggerAliases ?? []) {
        tgValueCompletions.push({
          label: alias,
          insert: needsQuote(alias) ? '`' + alias + '`' : alias,
          kind: 'special',
        });
      }
      if (tgOptions.insideExtract) {
        tgValueCompletions.push(EXTRACT_VALUE_COMPLETION);
      }
    }

    // Comparison RHS: if the token before the operator is a property with enum values, suggest them
    const comparisonEnumCompletions: Completion[] = [];
    const opTok = midTypingValue ? prevTok : lastTok;
    if (opTok && (opTok.type === 'op' || (opTok.type === 'keyword' && COMPARE_KEYWORDS.has(opTok.value)))) {
      const lhsTok = findTokenBefore(toks, opTok);
      if (lhsTok?.type === 'ident') {
        const lhsProp = contextProps.find(p => p.name.toLowerCase() === lhsTok.value.toLowerCase());
        if (lhsProp?.enumValues) {
          for (const v of lhsProp.enumValues) {
            comparisonEnumCompletions.push({ label: v, insert: `'${v.replace(/'/g, "\\'")}'`, kind: 'option' });
          }
        }
      }
    }

    // Output context: suggest target field option values as quoted string literals
    const outputCompletions: Completion[] = [];
    if (outputConstraints && outputConstraints.length > 0) {
      for (const v of outputConstraints) {
        const escaped = v.replace(/"/g, '\\"');
        outputCompletions.push({ label: `"${v}"`, insert: `"${escaped}"`, kind: 'option' });
      }
    }

    // Hoist option-kind completions (output constraints + comparison enum
    // values) above properties/edges/functions. When the author has
    // already pinned a comparison operator with an enum LHS, the closed
    // value set is far more likely the intended next token than another
    // property reference — keeping it at the top of the dropdown matches
    // the user's mental ordering.
    // WITHIN is only meaningful when at least one date field is in
    // scope — otherwise there's nothing the recency clause can compare
    // against. Hide the completion in that case so the agent / human
    // never sees a function they can't use.
    const hasDateField = contextProps.some((p) => p.valueType === 'date');
    // Field functions advertised on the target field being mapped (e.g.
    // SLACK_MESSAGE on a Slack message text field). Field-scoped — only
    // present in `tgOptions.fieldFunctions` when mapping that field (C6).
    const fieldFunctionCompletions: Completion[] = (tgOptions?.fieldFunctions ?? []).map((fn) => ({
      label: `${fn.name}()`,
      insert: `${fn.name}(`,
      kind: 'function' as const,
    }));
    const functionCompletions = filterCompletionsByCaps(
      [...FUNCTION_COMPLETIONS, ...fieldFunctionCompletions],
      capabilities,
    ).filter((c) => c.insert !== 'WITHIN(' || hasDateField);
    // Cypher-syntax hint completions (TG-only). Filtered by trailing
    // partial below — when the user has typed `-`, the bracket templates
    // surface; otherwise they sit at the bottom of the list.
    const cypherCompletions: Completion[] = tgOptions ? CYPHER_SYNTAX_COMPLETIONS : [];

    return filterCompletions([
      ...outputCompletions,
      ...comparisonEnumCompletions,
      ...tgValueCompletions,
      ...propCompletions,
      ...edgeBindCompletions,
      ...edgeCompletionsFor(contextEdges, effectiveNodeType, capabilities),
      ...(capabilities.kgGlobals === false ? [] : SPECIAL_COMPLETIONS),
      ...functionCompletions,
      ...cypherCompletions,
    ], trailingRaw);
  }

  // After a traversal step — expect .Property or another traversal (context already shifted)
  if (lastTok?.type === 'traverse') {
    // After a resource traversal, offer resource field completions
    if (isResourceHop(lastTok.value)) {
      return RESOURCE_FIELD_COMPLETIONS;
    }
    // After a linked object traversal, offer linked object field completions
    if (lastTok.value === '#linked' || lastTok.value.startsWith('#linked ')) {
      return LINKED_FIELD_COMPLETIONS;
    }
    const propCompletions: Completion[] = contextProps.map(p => ({
      label: p.name,
      insert: '.' + (needsQuote(p.name) ? '`' + p.name + '`' : p.name),
      kind: 'value' as const,
    }));
    // After the traversal token a leading dot is required before any
    // accessor — so dress up the bare `edge.X` entries with a `.`.
    const edgeBindAfterTraverse: Completion[] = edgeBindCompletions.map(c => ({
      ...c,
      label: `.${c.label}`,
      insert: `.${c.insert}`,
    }));
    return [
      ...propCompletions,
      { label: '@id', insert: '.@id', kind: 'special' },
      ...edgeBindAfterTraverse,
      ...edgeCompletionsFor(contextEdges, effectiveNodeType, capabilities),
    ];
  }

  // After a value or closing paren — offer operators filtered by type + traversal
  const afterValue =
    (lastTok?.type === 'ident') ||
    (lastTok?.type === 'string') ||
    (lastTok?.type === 'number') ||
    (lastTok?.type === 'special') ||
    (lastTok?.type === 'paren' && lastTok.value === ')') ||
    (lastTok?.type === 'keyword' && ['TRUE', 'FALSE', 'NULL', 'EXISTS'].includes(lastTok.value));

  if (afterValue) {
    let valueType: string | undefined;
    if (lastTok?.type === 'ident') {
      const prop = contextProps.find(p => p.name.toLowerCase() === lastTok.value.toLowerCase());
      valueType = prop?.valueType;
    }
    const ops = opsForValueType(valueType);
    const completions = [...ops, ...LOGICAL_OPS];
    if (ifDepth > 0) completions.push(...IF_BRANCH_COMPLETIONS);
    return filterCompletions(completions, lastWord);
  }

  return [];
}

function getLastWord(text: string): string {
  const match = text.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
  return match?.[0] ?? '';
}

function getTrailingNonWhitespace(text: string): string {
  const match = text.match(/\S+$/);
  return match?.[0] ?? '';
}

function filterCompletions(completions: Completion[], prefix: string): Completion[] {
  if (!prefix) return completions;
  const lower = prefix.toLowerCase();
  return completions.filter(c => {
    const label = c.label.toLowerCase();
    const insert = c.insert.toLowerCase();
    // Also match against inner content of quoted labels (e.g., "general" matches gen)
    const unquoted = label.startsWith('"') || label.startsWith("'") ? label.slice(1) : label;
    return label.startsWith(lower) || insert.startsWith(lower) || unquoted.startsWith(lower);
  });
}
