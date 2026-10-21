// Display lexer for formula / source-traversal syntax highlighting.
//
// This is a *display* lexer, deliberately separate from the parser's
// `tokenize()` in `movement-lang/expression/formula`. The parser collapses
// an entire `-[ … #extract { … } … ]->` traversal into one opaque token
// (storing the config as trimmed text with its offsets discarded), so it
// can't drive coloring *inside* a config — exactly where authors edit.
// This lexer instead tiles the whole input into contiguous, position-
// accurate spans so the overlay can paint every character, nested config
// interiors included. It mirrors the grammar's lexical surface (keywords,
// `ident(` = function, backtick properties, `#meta-edges`, `@globals`) but
// makes no parsing/resolution claims — coloring only.

import { KEYWORDS } from '@listen-fire/legacy-engine/formula/parser';

export type HighlightClass =
  | 'keyword'
  | 'function'
  | 'string'
  | 'number'
  | 'property'
  | 'meta-edge'
  | 'global'
  | 'punctuation'
  | 'plain';

export interface HighlightSpan {
  start: number;
  end: number;
  cls: HighlightClass;
  text: string;
}

const isSpace = (ch: string) =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch);
const isIdentChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);

/** Consume a quote-delimited run (string `"`/`'` or backtick property),
 *  honoring `\`-escapes. Returns the index just past the closing quote
 *  (or end-of-input for an unterminated literal). */
function scanQuoted(input: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < input.length && input[i] !== quote) {
    if (input[i] === '\\' && i + 1 < input.length) i++;
    i++;
  }
  return i < input.length ? i + 1 : i;
}

export function highlightTokens(input: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const push = (start: number, end: number, cls: HighlightClass) => {
    if (end > start) {
      spans.push({ start, end, cls, text: input.slice(start, end) });
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (isSpace(ch)) {
      const start = i;
      while (i < input.length && isSpace(input[i])) i++;
      push(start, i, 'plain');
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = scanQuoted(input, i, ch);
      push(i, end, 'string');
      i = end;
      continue;
    }

    if (ch === '`') {
      const end = scanQuoted(input, i, '`');
      push(i, end, 'property');
      i = end;
      continue;
    }

    if (ch === '@' || ch === '#') {
      const start = i;
      i++;
      while (i < input.length && (isIdentChar(input[i]) || input[i] === '.')) i++;
      push(start, i, ch === '@' ? 'global' : 'meta-edge');
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      while (i < input.length && (isDigit(input[i]) || input[i] === '.')) i++;
      push(start, i, 'number');
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < input.length && isIdentChar(input[i])) i++;
      const word = input.slice(start, i);
      // Look past whitespace: an identifier immediately calling `(` is a
      // function (the grammar treats every `ident(` as a function call).
      let j = i;
      while (j < input.length && isSpace(input[j])) j++;
      const cls: HighlightClass =
        input[j] === '('
          ? 'function'
          : KEYWORDS.has(word.toUpperCase())
            ? 'keyword'
            : 'plain';
      push(start, i, cls);
      continue;
    }

    // Traversal arrow delimiters render as meta-edge (pink) so a step
    // reads as a step. Longest match first so `]->` wins over `]-`.
    const arrow = ['<-[', ']->', '-[', ']-'].find((a) => input.startsWith(a, i));
    if (arrow) {
      push(i, i + arrow.length, 'meta-edge');
      i += arrow.length;
      continue;
    }

    // Everything else — brackets, braces, parens, colons, commas,
    // operators — is structural punctuation, one char per span.
    push(i, i + 1, 'punctuation');
    i++;
  }

  return spans;
}
