; General captures first; Zed lets a later pattern override an earlier one.

(identifier) @variable
(quoted_identifier) @variable

(comment) @comment

; ── literals ──

(string) @string
(escape_sequence) @string.escape
(interpolation
  "${" @punctuation.special
  "}" @punctuation.special)
(number) @number
(duration) @number
(boolean) @boolean
(null) @constant.builtin
(special) @variable.special

; ── declarations ──

(function_declaration name: (_) @function)
(listen_declaration function: (_) @function)
(listen_declaration channel: (_) @variable.special)
(node_declaration name: (_) @type)
(node_declaration base: (_) @type)
(nested_node name: (_) @property)
(node_field name: (_) @property)
(type_declaration name: (_) @type)
(parameter name: (_) @variable.parameter)
(import_specifier alias: (_) @variable.special)
(import_source) @keyword
(connect_expression adapter: (_) @variable.special)
(connect_expression credential: (_) @variable.special)

; ── expressions ──

(call_expression function: (identifier) @function)
(call_expression function: (quoted_identifier) @function)
(call_expression
  function: (member_expression property: (property (_) @function)))
(member_expression
  object: (identifier) @type
  (#match? @type "^[A-Z]")
  property: (property (_) @function))
(property (_) @property)
(record_field key: (property (_) @property))
(unique_by (property (_) @property))

; ── walks and types ──

(hop alias: (_) @variable)
(edge (_) @type)
(hop_head) @attribute
(type_name (_) @type)
((type_name (identifier) @type.builtin)
  (#any-of? @type.builtin "text" "number" "boolean" "date" "datetime" "duration" "file" "json" "any" "list" "url" "email"))
(edge_type channel: (_) @variable.special)

; ── keywords and operators ──

[
  "import" "from" "as" "export"
  "node" "extends" "type"
  "function" "movement"
  "listen" "to" "fire"
  "if" "else" "return"
  "write" "connect" "using" "await"
  "link" "unlink" "delete"
  "unique" "by" "order"
  "WHERE" "ORDER" "BY" "ASC" "DESC" "LIMIT" "FUZZY"
  "AND" "OR" "NOT" "CONTAINS" "IN" "IS"
] @keyword

[
  "=" "==" "!=" "<=" ">=" "+" "-" "*" "/" "%"
  "&&" "||" "!" "?" "=>" "..."
] @operator

(binary_expression operator: ["<" ">"] @operator)
(set_if_empty) @operator

["-[" "<-[" "]->" "]-"] @punctuation.special
(type_marker ["<" ">"] @punctuation.bracket)
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["," "." ":"] @punctuation.delimiter
