/**
 * Tree-sitter grammar for listen-fire movement files (`.mvt`), language
 * version 5 ("Dancing Wren").
 *
 * This grammar exists for editors: highlighting, bracket matching,
 * indentation, outline. It is deliberately more permissive than the real
 * parser (crates/movement-parser) and never decides whether a program is
 * valid — the language server (`lf lsp`) does that. When the two disagree,
 * the real parser is right; widen this grammar rather than narrow it.
 */

/** A keyword the lexer reads case-insensitively (`AND`, `and`, `And`). */
const ci = (word) =>
  alias(
    new RegExp(
      word
        .split('')
        .map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
        .join(''),
    ),
    word.toUpperCase(),
  );

const PREC = {
  closure: -1,
  ternary: 1,
  or: 2,
  and: 3,
  not: 4,
  compare: 5,
  add: 6,
  multiply: 7,
  prefix: 8,
  postfix: 10,
};

const commaSep = (rule) => seq(rule, repeat(seq(',', rule)), optional(','));

module.exports = grammar({
  name: 'movement',

  word: ($) => $.identifier,

  extras: ($) => [/\s/, $.comment],

  conflicts: ($) => [
    [$._expression, $.parameter],
  ],

  rules: {
    source_file: ($) => repeat($._statement),

    // ── statements ──

    _statement: ($) =>
      choice(
        $.import_statement,
        $.node_declaration,
        $.type_declaration,
        $.function_declaration,
        $.listen_declaration,
        $.if_statement,
        $.return_statement,
        $.link_statement,
        $.delete_statement,
        $.assignment,
        $.traversal_block,
        $.expression_statement,
      ),

    import_statement: ($) =>
      seq(
        'import',
        '{',
        commaSep($.import_specifier),
        '}',
        'from',
        field('source', choice($.import_source, $.string)),
      ),

    import_specifier: ($) =>
      seq(field('name', $._name), optional(seq('as', field('alias', $._name)))),

    import_source: (_) => choice('adapters', 'credentials', 'plugins'),

    node_declaration: ($) =>
      seq(
        optional('export'),
        'node',
        field('name', $._name),
        optional(seq('extends', field('base', $._name))),
        optional(seq(':', field('description', $.string))),
        field('body', $.node_body),
      ),

    node_body: ($) =>
      seq('{', repeat(choice($.node_field, $.nested_node, ',')), '}'),

    node_field: ($) =>
      seq(
        field('name', $._name),
        ':',
        field('type', $.type_marker),
        optional(field('description', $.string)),
      ),

    nested_node: ($) =>
      prec.right(
        seq(
          'node',
          field('name', $._name),
          optional(seq(':', field('description', $.string))),
          field('body', $.node_body),
          optional(seq('order', 'by', $.identifier)),
        ),
      ),

    type_declaration: ($) =>
      seq('type', field('name', $._name), '=', field('value', $.type_marker)),

    function_declaration: ($) =>
      seq(
        optional('export'),
        choice('function', 'movement'),
        field('name', $._name),
        field('parameters', $.parameter_list),
        optional(seq(':', field('return_type', $.type_marker))),
        field('body', $.block),
      ),

    parameter_list: ($) => seq('(', optional(commaSep($.parameter)), ')'),

    parameter: ($) =>
      seq(field('name', $._name), optional(seq(':', field('type', $.type_marker)))),

    listen_declaration: ($) =>
      seq(
        'listen',
        optional(seq('as', field('label', $.string))),
        'to',
        field('channel', $._name),
        optional(field('arguments', $.arguments)),
        optional(field('config', $.record)),
        'fire',
        field('function', $._name),
      ),

    if_statement: ($) =>
      prec.right(
        seq(
          'if',
          field('condition', $._expression),
          field('consequence', $.block),
          repeat(seq('else', 'if', $._expression, $.block)),
          optional(seq('else', field('alternative', $.block))),
        ),
      ),

    return_statement: ($) => prec.right(seq('return', optional($._expression))),

    // `link a -[:e]-> b`: the target after the hop parses as the next
    // expression statement, which highlights the same.
    link_statement: ($) => seq(choice('link', 'unlink'), $._expression),

    delete_statement: ($) => seq('delete', $._expression),

    assignment: ($) =>
      seq(field('left', choice($._name, $.member_expression)), '=', field('right', $._expression)),

    /** `crm-[c:Companies WHERE …]-> { … }`: run the block for each record reached. */
    traversal_block: ($) => prec(1, seq(field('walk', $._expression), field('body', $.block))),

    expression_statement: ($) => $._expression,

    // Wins over a record where both could be meant: `() => { … }` is a body.
    block: ($) => prec(1, seq('{', repeat($._statement), '}')),

    // ── expressions ──

    _expression: ($) =>
      choice(
        $._name,
        $.number,
        $.duration,
        $.string,
        $.boolean,
        $.null,
        $.special,
        $.list,
        $.record,
        $.type_marker,
        $.parenthesized_expression,
        $.member_expression,
        $.call_expression,
        $.index_expression,
        $.walk_expression,
        $.binary_expression,
        $.unary_expression,
        $.conditional_expression,
        $.closure,
        $.write_expression,
        $.connect_expression,
        $.await_expression,
        $.node_literal,
        $.spread,
      ),

    parenthesized_expression: ($) => seq('(', $._expression, ')'),

    member_expression: ($) =>
      prec(
        PREC.postfix,
        seq(field('object', $._expression), '.', field('property', alias($._name, $.property))),
      ),

    call_expression: ($) =>
      prec(PREC.postfix, seq(field('function', $._expression), field('arguments', $.arguments))),

    arguments: ($) => seq('(', optional(commaSep($._expression)), ')'),

    index_expression: ($) =>
      prec(PREC.postfix, seq(field('object', $._expression), '[', field('index', $._expression), ']')),

    /** `crm-[c:Companies WHERE …]->`: the records one hop away. */
    walk_expression: ($) => prec(PREC.postfix, seq(field('from', $._expression), $.hop)),

    hop: ($) =>
      seq(
        choice('-[', '<-['),
        optional($._hop_head),
        repeat($._hop_clause),
        choice(']->', ']-'),
      ),

    _hop_head: ($) =>
      choice(
        seq(field('alias', $._name), ':', field('edge', alias($._name, $.edge))),
        seq(':', field('edge', alias($._name, $.edge))),
        seq(field('alias', $._name), ':', field('head', $.hop_head)),
        field('head', $.hop_head),
      ),

    hop_head: ($) => seq(token(prec(2, /#[A-Za-z_][A-Za-z0-9_]*/)), optional($.record)),

    _hop_clause: ($) =>
      choice(
        seq(ci('where'), $._expression),
        seq(ci('order'), ci('by'), commaSep(seq($._expression, optional(choice(ci('asc'), ci('desc')))))),
        seq(ci('limit'), $._expression),
      ),

    binary_expression: ($) => {
      const table = [
        [PREC.or, choice(ci('or'), '||')],
        [PREC.and, choice(ci('and'), '&&')],
        [PREC.compare, choice('==', '!=', '<', '>', '<=', '>=', ci('contains'), ci('in'), ci('is'))],
        [PREC.add, choice('+', '-')],
        [PREC.multiply, choice('*', '/', '%')],
      ];
      return choice(
        ...table.map(([p, operator]) =>
          prec.left(
            p,
            seq(field('left', $._expression), field('operator', operator), field('right', $._expression)),
          ),
        ),
      );
    },

    unary_expression: ($) =>
      prec(PREC.not, seq(field('operator', choice('!', ci('not'))), field('argument', $._expression))),

    conditional_expression: ($) =>
      prec.right(
        PREC.ternary,
        seq(
          field('condition', $._expression),
          '?',
          field('consequence', $._expression),
          ':',
          field('alternative', $._expression),
        ),
      ),

    closure: ($) =>
      prec.right(
        PREC.closure,
        seq(
          field('parameters', $.parameter_list),
          optional(seq(':', field('return_type', $.type_marker))),
          '=>',
          field('body', choice($.block, $._expression)),
        ),
      ),

    write_expression: ($) =>
      prec.right(PREC.prefix, seq('write', field('target', $._expression), field('body', $.record))),

    connect_expression: ($) =>
      prec.right(
        seq(
          'connect',
          field('adapter', $._name),
          optional(seq('using', field('credential', $._name))),
          optional(field('options', $.record)),
        ),
      ),

    await_expression: ($) => prec.right(PREC.prefix, seq('await', $._expression)),

    node_literal: ($) => seq('node', $.record),

    spread: ($) => prec(PREC.prefix, seq('...', $._expression)),

    list: ($) => seq('[', optional(commaSep($._expression)), ']'),

    /** An object literal, a listen's config, or a write's body. */
    record: ($) => seq('{', repeat(choice($.record_field, $.unique_by, ',')), '}'),

    record_field: ($) =>
      seq(
        field('key', alias($._name, $.property)),
        choice(':', alias('?:', $.set_if_empty)),
        field('value', $._expression),
      ),

    unique_by: ($) =>
      seq(
        'unique',
        'by',
        '(',
        commaSep(seq(optional(ci('fuzzy')), alias($._name, $.property))),
        ')',
      ),

    // ── types ──

    type_marker: ($) => seq('<', $._type, '>'),

    _type: ($) => choice($.union_type, $._type_atom),

    union_type: ($) => prec.left(seq($._type, '|', $._type_atom)),

    _type_atom: ($) =>
      choice(
        alias($._name, $.type_name),
        $.string,
        $.null,
        $.edge_type,
        $.function_type,
        $.type_marker,
        seq($._type_atom, '[', ']'),
      ),

    /** `<crm-[:Company]->>`: what arrives along an adapter's edge. */
    edge_type: ($) => seq(field('channel', $._name), $.hop),

    function_type: ($) => seq($.parameter_list, '=>', $.type_marker),

    // ── tokens ──

    _name: ($) => choice($.identifier, $.quoted_identifier),

    identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*/,

    /** A backtick-quoted name: always a name, never a keyword. */
    quoted_identifier: (_) => token(seq('`', /([^`\\\n]|\\.)*/, '`')),

    special: (_) => token(seq('@', /[A-Za-z0-9_.]+/)),

    number: (_) => token(seq(optional('-'), /\d+(\.\d+)*/)),

    duration: (_) => /\d+[A-Za-z][A-Za-z0-9]*/,

    boolean: (_) => choice(ci('true'), ci('false')),

    null: (_) => ci('null'),

    string: ($) =>
      choice(
        seq(
          '"',
          repeat(
            choice(
              alias($._double_content, $.string_content),
              $.escape_sequence,
              $.interpolation,
            ),
          ),
          token.immediate('"'),
        ),
        seq(
          "'",
          repeat(choice(alias($._single_content, $.string_content), $.escape_sequence)),
          token.immediate("'"),
        ),
      ),

    _double_content: (_) => token.immediate(prec(1, /([^"\\$]|\$[^{"\\])+|\$/)),

    _single_content: (_) => token.immediate(prec(1, /[^'\\]+/)),

    escape_sequence: (_) => token.immediate(/\\./),

    interpolation: ($) => seq(token.immediate(prec(2, '${')), $._expression, '}'),

    comment: (_) => token(seq('#', /.*/)),
  },
});
