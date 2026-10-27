# lf cheat sheet

A short reference to the language's core forms, drawn from the handbook's
front page and reference chapter and the modules' own chapters. It is generic:
nothing in it is about one automation. handbook_read and handbook_search have
the rest.

## A file

```
import { webhook, mcp, gmail, slack } from adapters    # adapter types
import { my_hook, my_crm } from credentials           # connections, by their saved names

hook = connect webhook using my_hook                   # connect once, at file scope
crm  = connect mcp using my_crm

node Event {                                           # a declared structure
  id: <text>
  kind: <text>
  data: <json>
}

function `On Event`(e: <Event>) { … }                  # one typed parameter

listen to hook { payload: <Event> } fire `On Event`    # the one way an automation runs
```

- Comments start with `#`. No semicolons. A name is bound once: `x = …` (no `let`/`const`).
- Backticks quote a name with spaces; double quotes are always a string.
- Types wear angle brackets: `<text>`, `<number>`, `<boolean>`, `<date>`, `<json>`, `<Event>`.
  `<text | null>` for a field that may be missing.
- `type Kind = <"a" | "b">` declares a set of values; `<Kind>` uses it.

## Values

- `==` `!=` `<` `>`; `&&` `||` `!`; `c ? a : b`. `+` only adds numbers.
- Strings interpolate: `"Hello ${p.name}"`.
- A dot reads a field, including into a payload's nested objects: `e.data.items`.
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
record's fields. `describe_systems` (or `lf catalog`) lists every type and
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

- `lf check`: every diagnostic, with the code and a fix. It reads each
  connection's live description, so a field, a type or a value a system does
  not have is refused before anything runs.
- `lf run --event <file> --dry-run`: one run on an event, reads made,
  writes shown and not made.
- `lf runs`, `lf runs show <id>`: what each run did, its event, trace and error.
