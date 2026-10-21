/**
 * The Gmail search subset the fake understands, as a parser plus an evaluator.
 *
 *   query   := and-list of or-groups            (implicit AND; OR binds tighter, as in Gmail)
 *   or      := unary (("OR" | "|") unary)*
 *   unary   := "-" unary | "(" query ")" | "{" unary* "}" | field ":" unary | phrase | word
 *
 * Anything outside it throws GmailQueryError. A silent "matches nothing" would
 * make a gap in the fake look like a failure of whatever built the query.
 */

export class GmailQueryError extends Error {}

export type QueryNode =
  | { kind: 'and'; items: QueryNode[] }
  | { kind: 'or'; items: QueryNode[] }
  | { kind: 'not'; item: QueryNode }
  | { kind: 'term'; field: string | null; value: string };

const FIELD_OPERATORS = new Set([
  'subject', 'from', 'to', 'cc', 'bcc', 'label', 'in', 'has', 'filename', 'is',
  'category', 'after', 'before', 'newer_than', 'older_than',
]);

export function parseGmailQuery(query: string): QueryNode {
  const parser = new Parser(query);
  const node = parser.parseAnd(null);
  parser.expectEnd();
  return node;
}

class Parser {
  private at = 0;
  constructor(private readonly src: string) {}

  expectEnd(): void {
    this.skipSpace();
    if (this.at < this.src.length) this.fail(`unmatched "${this.src[this.at]}"`);
  }

  parseAnd(field: string | null): QueryNode {
    const items: QueryNode[] = [];
    for (;;) {
      this.skipSpace();
      const c = this.src[this.at];
      if (c === undefined || c === ')' || c === '}') break;
      if (this.consumeKeyword('AND')) continue;
      items.push(this.parseOr(field));
    }
    return items.length === 1 ? items[0] : { kind: 'and', items };
  }

  private parseOr(field: string | null): QueryNode {
    const items = [this.parseUnary(field)];
    for (;;) {
      this.skipSpace();
      if (this.consumeKeyword('OR') || this.consumeChar('|')) {
        this.skipSpace();
        if (this.atEnd() || ')}'.includes(this.src[this.at])) this.fail('"OR" with nothing after it');
        items.push(this.parseUnary(field));
      } else break;
    }
    return items.length === 1 ? items[0] : { kind: 'or', items };
  }

  private parseUnary(field: string | null): QueryNode {
    this.skipSpace();
    const c = this.src[this.at];
    if (c === undefined) this.fail('unexpected end of query');
    if (c === '-') {
      this.at++;
      return { kind: 'not', item: this.parseUnary(field) };
    }
    if (c === '(') {
      this.at++;
      const inner = this.parseAnd(field);
      this.close(')');
      return inner;
    }
    if (c === '{') {
      this.at++;
      const items: QueryNode[] = [];
      for (;;) {
        this.skipSpace();
        if (this.atEnd() || this.src[this.at] === '}') break;
        items.push(this.parseUnary(field));
      }
      this.close('}');
      return { kind: 'or', items };
    }
    if (c === ')' || c === '}') this.fail(`unmatched "${c}"`);
    if (c === '"') return this.term(field, this.phrase());

    const word = this.word();
    const colon = word.indexOf(':');
    if (colon <= 0) {
      if (word === 'OR') this.fail('"OR" with nothing before it');
      return this.term(field, word);
    }
    const operator = word.slice(0, colon).toLowerCase();
    if (!FIELD_OPERATORS.has(operator)) this.fail(`unsupported operator "${operator}:"`);
    if (field !== null) this.fail(`operator "${operator}:" nested inside "${field}:"`);
    const rest = word.slice(colon + 1);
    if (rest !== '') return this.term(operator, rest);
    const next = this.src[this.at];
    if (next === undefined || /\s/.test(next)) this.fail(`"${operator}:" with no value`);
    return this.parseUnary(operator);
  }

  /** Values are checked here, not at match time, so a bad `has:drive` fails
   *  even when the mailbox is empty. */
  private term(field: string | null, value: string): QueryNode {
    evaluateTerm(field, value.toLowerCase(), EMPTY_TARGET, 0);
    return { kind: 'term', field, value };
  }

  private word(): string {
    const start = this.at;
    while (this.at < this.src.length && !/[\s(){}"|]/.test(this.src[this.at])) this.at++;
    if (this.at === start) this.fail(`unexpected "${this.src[start]}"`);
    return this.src.slice(start, this.at);
  }

  private phrase(): string {
    const end = this.src.indexOf('"', this.at + 1);
    if (end < 0) this.fail('unterminated quote');
    const value = this.src.slice(this.at + 1, end);
    this.at = end + 1;
    return value;
  }

  private close(char: ')' | '}'): void {
    this.skipSpace();
    if (this.src[this.at] !== char) this.fail(`missing "${char}"`);
    this.at++;
  }

  private consumeKeyword(word: string): boolean {
    if (!this.src.startsWith(word, this.at)) return false;
    const after = this.src[this.at + word.length];
    if (after !== undefined && !/[\s(){}"]/.test(after)) return false;
    this.at += word.length;
    return true;
  }

  private consumeChar(char: string): boolean {
    if (this.src[this.at] !== char) return false;
    this.at++;
    return true;
  }

  private atEnd(): boolean {
    return this.at >= this.src.length;
  }

  private skipSpace(): void {
    while (this.at < this.src.length && /\s/.test(this.src[this.at])) this.at++;
  }

  private fail(reason: string): never {
    throw new GmailQueryError(`Unsupported Gmail search "${this.src}": ${reason} (at offset ${this.at})`);
  }
}

/** What a query can be asked about a message. */
export interface QueryTarget {
  headers: Map<string, string>;
  labels: string[];
  filenames: string[];
  freeText: string;
  internalDateMs: number;
}

export function evaluateGmailQuery(node: QueryNode, target: QueryTarget, nowMs: number): boolean {
  switch (node.kind) {
    case 'and':
      return node.items.every((item) => evaluateGmailQuery(item, target, nowMs));
    case 'or':
      return node.items.some((item) => evaluateGmailQuery(item, target, nowMs));
    case 'not':
      return !evaluateGmailQuery(node.item, target, nowMs);
    case 'term':
      return evaluateTerm(node.field, node.value.toLowerCase(), target, nowMs);
  }
}

const EMPTY_TARGET: QueryTarget = { headers: new Map(), labels: [], filenames: [], freeText: '', internalDateMs: 0 };

const DAY_MS = 86_400_000;
const AGE_UNIT_MS: Record<string, number> = { h: 3_600_000, d: DAY_MS, m: 30 * DAY_MS, y: 365 * DAY_MS };

function evaluateTerm(field: string | null, value: string, target: QueryTarget, nowMs: number): boolean {
  switch (field) {
    case null:
      return target.freeText.includes(value);
    case 'subject':
    case 'from':
    case 'to':
    case 'cc':
    case 'bcc':
      return (target.headers.get(field) ?? '').toLowerCase().includes(value);
    case 'label':
    case 'in':
      return target.labels.some((label) => label.toLowerCase() === value);
    case 'filename':
      return target.filenames.some((name) => name.toLowerCase().includes(value));
    case 'has':
      if (value === 'attachment') return target.filenames.length > 0;
      throw new GmailQueryError(`Unsupported Gmail search: "has:${value}" (only has:attachment)`);
    case 'is': {
      if (value === 'read') return !target.labels.includes('UNREAD');
      const label = { unread: 'UNREAD', starred: 'STARRED', important: 'IMPORTANT' }[value];
      if (label === undefined) {
        throw new GmailQueryError(
          `Unsupported Gmail search: "is:${value}" (only is:unread, is:read, is:starred, is:important)`,
        );
      }
      return target.labels.includes(label);
    }
    case 'category':
      if (!INBOX_CATEGORIES.has(value)) {
        throw new GmailQueryError(
          `Unsupported Gmail search: "category:${value}" (only ${[...INBOX_CATEGORIES].map((c) => `category:${c}`).join(', ')})`,
        );
      }
      return categoryOf(target.labels) === value;
    case 'after':
    case 'before': {
      const bound = parseQueryDate(value);
      if (bound === null) {
        throw new GmailQueryError(`Unsupported Gmail search: "${field}:${value}" is not a date (YYYY/MM/DD or epoch seconds)`);
      }
      return field === 'after' ? target.internalDateMs >= bound : target.internalDateMs < bound;
    }
    case 'newer_than':
    case 'older_than': {
      const match = /^(\d+)([hdmy])$/.exec(value);
      if (match === null) {
        throw new GmailQueryError(`Unsupported Gmail search: "${field}:${value}" (expected a count and h, d, m or y, e.g. 2d)`);
      }
      const cutoff = nowMs - Number(match[1]) * AGE_UNIT_MS[match[2]];
      return field === 'newer_than' ? target.internalDateMs >= cutoff : target.internalDateMs < cutoff;
    }
    default:
      throw new GmailQueryError(`Unsupported Gmail search operator "${field}:"`);
  }
}

const INBOX_CATEGORIES = new Set(['primary', 'social', 'promotions', 'updates', 'forums']);

/** A message's inbox tab, from its system label the way Gmail stores it
 *  (`CATEGORY_PROMOTIONS`, …; Primary is `CATEGORY_PERSONAL`). A message with no
 *  category label sits in Primary, which is where fixtures' mail belongs. */
function categoryOf(labels: string[]): string {
  for (const label of labels) {
    if (!label.startsWith('CATEGORY_')) continue;
    const name = label.slice('CATEGORY_'.length).toLowerCase();
    if (name === 'personal') return 'primary';
    if (INBOX_CATEGORIES.has(name)) return name;
  }
  return 'primary';
}

function parseQueryDate(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const parts = value.split('/').map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  }
  return null;
}
