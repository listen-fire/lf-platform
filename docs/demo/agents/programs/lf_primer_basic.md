# listen-fire primer

Each connected system is a graph of typed records joined by edges, which the catalog describes live. A connection's types are edges off it: `mail-[:Messages]->` reads the mailbox's messages and `write mail-[:Messages]-> {…}` sends one; no container record holds them. A program is listens that fire functions. A walk along edges, filtered by `WHERE`, answers a set in no order: order it before `first`, `Text.join` or `reduce`. A function body runs its steps in order. The checker knows each system's real shape, including what may be absent (`first`, `only`, an extracted field).

```
gh   = connect `@lf/github` using my_github
mail = connect `@lf/gmail` using team_mail

# What extract asks a model to fill from text, field by field.
type Severity = <"blocker" | "major" | "minor">
node Bug: "the bug this issue reports, if it reports one" {
  severity: <Severity> "how badly it hurts users"
}

function `Weekly bugs`(t: <cron-[:Ticks]->>) {
  repo = only(gh-[r:Repositories WHERE r.`Full Name` == "acme/api"]->)
  if (repo == null) { fail("acme/api not found; nothing sent") }   # fail stops the run and tells you, for unexpected data
  # The block runs once per open issue; lines holds each one's answer.
  lines = repo-[i:Issues WHERE i.State == "open" ORDER BY i.Number]-> {
    bug = extractOne([i.Title, i.Body], Bug)
    if (bug == null) { return "#${i.Number} ${i.Title}: not a bug" }
    return "#${i.Number} ${i.Title} (${coalesce(bug.severity, "unrated")}): ${i.`HTML URL`}"
  }
  write mail-[:Messages]-> { To: ["team@example.com"], Subject: "Open bugs", Body: Text.join(lines, "\n") }
}

listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1"]-> fire `Weekly bugs`   # cron needs no connect
```

Before reading the handbook, call `example` with what you want to do (`example count per person`): it answers a few checked lines, and the handbook is read by section (`system:slack#shapes-of-post`), as its index lists them, never a whole chapter. `listen-fire check` gives every mistake with a fix, and lists a type's real fields. A test run lists each write it made, with its fields. Skip a record you mean to skip; `fail` when data isn't what the program expects: a failed run tells you, a quiet fallback doesn't.
