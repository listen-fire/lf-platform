# listen-fire primer

Each connected system is a graph: typed records joined by named edges (a GitHub
notification leads to its repository and its pull request). `describe_systems`
shows each system's real records, fields, edges and writes. A program is
listens that fire functions: a listen waits on an edge where a system announces
arrivals, and fires a function for each arrival its `WHERE` lets through.
Reading is declarative: write a walk along edges, filtered by `WHERE`, and get
the records it reaches. A function body is imperative: steps run in order. A
write goes along an edge too. The checker knows each system's real shape,
including which values may be absent, and refuses a mismatch before anything
runs.

```
gh   = connect `@lf/github` using my_github   # each system once: its module, then the saved connection it signs in with
mail = connect `@lf/gmail` using team_mail
chat = connect `@lf/slack` using my_slack

# The parameter is typed by the record the listen (last line) lands on.
function `Review requested`(n: <gh-[:Notification]->>) {
  pr = only(n-[:`Pull Request`]->)   # the one record along the edge, or absent (more than one fails the run)
  if (pr == null) { fail("not a pull request: ${n.Title}") }   # the one test; every read of pr after it is safe
  repo = n-[:Repository]->.`Full Name`   # backticks quote a name with spaces
  # ?. reads through a record that may be absent; coalesce takes the first value that is there
  author = coalesce(only(chat-[u:Users WHERE u.Name == pr.Author]->)?.`Real Name`, pr.Author)
  others = count(pr.`Requested Reviewers`) - 1
  # A name is bound once: no let, no reassigning, no semicolons. + adds numbers only; build text with "${…}".
  line = "${author} asks for a review of ${repo}#${pr.Number}: ${Text.trim(pr.Title)}"

  if (pr.Draft) {
    return "a draft; nothing to do"   # ends the run, handing back a value
  } else if (Text.includes(Text.lower(pr.Title), "hotfix")) {   # functions, not methods
    write pr-[:Labels]-> { Name: "urgent" }   # GitHub keys a label by its name, so a repeat adds nothing
    write mail-[:Messages]-> { To: ["oncall@example.com"], Subject: "Hotfix in ${repo}", Body: "${line}\n${pr.`HTML URL`}" }
  } else {
    write pr-[:Comments]-> { Body: "Seen; I will review this today." }
  }

  # No loops: a block after a walk runs once per record it reaches, here the channel named general.
  chat-[ch:Channels WHERE ch.Name == "general"]-> {
    write ch-[:Messages]-> { Message: "${line} (${others} other reviewers) ${pr.`HTML URL`}" }
  }
}

listen to gh-[n:Notifications WHERE n.Reason == "review_requested"]-> fire `Review requested`
```

- Where a system lets you name identity, `write x-[:Things]-> { unique by (Email), Email: e, … }` updates the record it finds, or creates one. Where the system keys records itself, as GitHub does, the checker refuses `unique by`.
- These words start statements, never names: `await`, `callback`, `delete`, `edge`, `else`, `ERROR`, `export`, `extract`, `function`, `if`, `import`, `link`, `listen`, `movement`, `refresh`, `return`, `run`, `shape`, `unlink`, `write`.
- Check your work: `listen-fire check` gives every mistake with a fix; `listen-fire run --event <file>` runs once for real; `listen-fire runs show <id>` shows what a run did. `handbook_search` answers the rest.
