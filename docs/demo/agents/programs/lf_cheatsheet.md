# listen-fire cheat sheet

A short reference to the language's core forms, drawn from the handbook's
front page and reference chapter and the modules' own chapters. It is generic:
nothing in it is about one automation. handbook_read and handbook_search have
the rest.

## A file

```
pay = connect `@lf/stripe` using my_stripe       # each system connected once, at file scope:
crm = connect `@lf/mcp` using my_crm             # its module, and the saved connection it signs in with

function `On Change`(c: <pay-[:InvoiceChange]->>) { … }   # one typed parameter: what the listen arrives at

listen to pay-[:Invoices]->-[c:Changes WHERE c.Kind == "…"]-> fire `On Change`   # the one way an automation runs
```

Nothing is imported: a module is named where it is connected, a connection by
the name it was saved under (`listen-fire credential list`). A listen is a
walk from a connection to the edge its system announces arrivals on; its
`WHERE` picks which arrivals run. The parameter is typed by what lands: the
edge, or its record type, addressed from the connection. Each system's
arrival edges, their records' fields and their edges to the records they are
about are in `describe_systems` and the module's handbook chapter
(`system:<module>`).

- Comments start with `#`. No semicolons. A name is bound once: `x = …` (no `let`/`const`).
- Backticks quote a name with spaces; double quotes are always a string.
- Types wear angle brackets: `<text>`, `<number>`, `<boolean>`, `<date>`, `<json>`, `<conn-[:Things]->>`.
  `<text | null>` for a field that may be missing.
- `type Kind = <"a" | "b">` declares a set of values; `<Kind>` uses it.

## Values

- `==` `!=` `<` `>`; `&&` `||` `!`; `c ? a : b`. `+` only adds numbers.
- Strings interpolate: `"Hello ${p.name}"`.
- A dot reads a field, including into a json field's nested objects: `r.data.items`.
- Functions, not methods: `Text.lower(s)`, `Text.trim(s)`, `Text.split(s, " ")`,
  `Number.round(n)`, `coalesce(a, b)`, `count(xs)`, `first(xs)`, `only(xs)`.
- No loops: a block after a path runs once per record, `map`/`filter` iterate lists.

## Absent values

`first`, `only`, a lookup that may find nothing: `T | absent`. Narrow it before use:

```
r = only(sys-[x:Things WHERE x.key == k]->)
if (r == null) { fail("no thing ${k}") }
```

## Reading from a system

```
sys-[x:Things WHERE x.field == value]->            # a path; WHERE filters the hop
r = only(sys-[x:Things WHERE x.field == value]->)  # the one record, or absent
sys-[x:Things]-> { … }                             # a block runs once per record
```

An MCP server's read-only tool is a type you read from the connection: its
arguments are the `==` tests of the `WHERE`, its answer's fields are the
record's fields. `describe_systems` (or `listen-fire catalog`) lists every type and
field, with each field's kind; a field of a set of values lists them.

## Writing

```
write sys-[:Things]-> { field: value, other: "${x}" }    # create
write sys-[:Things]-> { unique by (key), key: k, … }      # create or update by identity
write channel-[:Messages]-> { Message: "…" }              # write along a record's edge
```

## Branching and failing

```
if (a == "x") { … } else if (a == "y") { … } else { … }
fail("reason")         # ends the run as failed, the reason kept in the run record
```

## Checking your work

- `listen-fire check`: every diagnostic, with the code and a fix. It reads each
  connection's live description, so a field, a type or a value a system does
  not have is refused before anything runs.
- `listen-fire run --event <file>`: one run on an event, for real (an event has
  no dry run; `--ephemeral` keeps the run out of the project's history).
- `listen-fire runs`, `listen-fire runs show <id>`: what each run did, its event, trace and error.
