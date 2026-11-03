# listen-fire primer

Each connected system is a graph: typed records joined by named edges (a GitHub
notification leads to its repository and its pull request). A connection's types
(a mailbox's messages, a base's tables) are edges off it: `gh-[:Repositories]->`
reads them, `write mail-[:Messages]-> { … }` creates one. A system with settings
shows its types once the connect carries them, as in
`connect … using x { base: "Support" }`. A program is listens that fire
functions: a listen waits on an edge where a system announces arrivals, and fires
a function for each one its `WHERE` lets through. A walk along edges, filtered by
`WHERE`, answers a set of records, in no order. A function body runs its steps
in order. The checker knows each system's real shape, including which values may
be absent (`first` and `only` may answer nothing, however sure you are), and
refuses a mismatch before anything runs.

```
gh   = connect `@lf/github` using my_github   # each system once: its module, then the saved connection
mail = connect `@lf/gmail` using team_mail
chat = connect `@lf/slack` using my_slack

# n is typed by the record the listen (at the end) lands on.
function `Review requested`(n: <gh-[:Notification]->>) {
  pr = only(n-[:`Pull Request`]->)   # the one record along the edge, or nothing (more than one fails the run)
  if (pr == null) { return "not a pull request: ${n.Title}" }   # return ends the run with a value
  # A walk is a set: ORDER BY (or sort) before first, Text.join or reduce.
  last = first(pr-[c:Comments ORDER BY c.`Created At` DESC]->)
  if (last?.Author == "me") { return "already answered" }   # ?. reads through a record that may be absent
  repo = n-[:Repository]->.`Full Name`   # backticks quote a name with spaces
  author = coalesce(only(chat-[u:Users WHERE u.Name == pr.Author]->)?.`Real Name`, pr.Author)   # the first value there
  # A name is bound once: no let, no reassigning, no semicolons. + adds numbers only; build text with "${…}".
  line = "${author} asks for a review of ${repo}#${pr.Number}: ${pr.`HTML URL`}"
  urgent = Text.includes(Text.lower(pr.Title), "hotfix")   # functions, not methods
  write pr-[:Comments]-> { Body: urgent ? "On it now." : "Seen; I will review this today." }
  # No loops: a block after a walk runs once per record it reaches.
  chat-[ch:Channels WHERE ch.Name == "general"]-> { write ch-[:Messages]-> { Message: line } }
}

# A shape for the run's own graph, which a run writes and walks.
node Board {
  node people {
    name: <text>
    node pulls { title: <text> }
  }
}

# To group or count (a dict's keys can't be listed), file records under parents in the run's own graph, then walk them.
function `Weekly digest`(t: <cron-[:Ticks]->>) {
  board = graph<Board> {}
  gh-[:Repositories]->-[p:`Pull Requests` WHERE p.State == "open"]-> {
    person = write board-[:people]-> { unique by (name), name: p.Author }   # finds by name, or creates
    write person-[:pulls]-> { title: p.Title }
  }
  # A block answers one value per record: here, one line per person.
  lines = board-[x:people ORDER BY x.name]-> { return "${x.name}: ${count(x-[:pulls]->)}" }
  digest = "${count(board-[:people]->-[:pulls]->)} open pull requests\n${Text.join(lines, "\n")}"
  write mail-[:Messages]-> { To: ["team@example.com"], Subject: "Open pull requests", Body: digest }   # straight off the connection
  return digest   # a test run shows it
}

listen to gh-[n:Notifications WHERE n.Reason == "review_requested"]-> fire `Review requested`
listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1" AND t.Zone == "Europe/London"]-> fire `Weekly digest`   # Mondays 09:00; cron needs no connect
```

- `unique by (…)` updates the record it finds, or creates one: in the run's own graph, and in a system that lets you name identity. Where a system keys records itself, as GitHub does, the checker refuses it.
- A name can't be a word of the language (`if`, `write`, `return`, `in`, `end`, `not`, …) or a built-in (`all`, `count`, `first`, `sort`, `map`, `fail`, …).
- There is no print: `return` a value to see it. A test run shows what the run returned and what it wrote. `listen-fire check` gives every mistake with a fix, and lists a type's real fields. `handbook_search` answers the rest.
