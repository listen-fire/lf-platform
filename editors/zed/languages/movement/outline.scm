(import_statement "import" @context source: (_) @name) @item

(function_declaration
  "export"? @context
  ["function" "movement"] @context
  name: (_) @name) @item

(node_declaration
  "export"? @context
  "node" @context
  name: (_) @name) @item

(type_declaration "type" @context name: (_) @name) @item

(listen_declaration
  "listen" @context
  "to" @context
  channel: (_) @name
  "fire" @context
  function: (_) @name) @item

(source_file
  (assignment
    left: (_) @name
    right: (connect_expression "connect" @context)) @item)
