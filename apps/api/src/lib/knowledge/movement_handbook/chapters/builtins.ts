import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Chapter } from '../types';

// The built-ins reference travels with the language: the language service's
// hover reads the same file when it is compiled, so the two cannot drift. The
// path holds from src/ and from the compiled build/ alike (the same depth).
const BUILTINS_REFERENCE = join(__dirname, '../../../../../../../crates/movement-language/src/builtins.md');

export const builtins: Chapter = {
  id: 'builtins',
  title: 'Builtins',
  content: readFileSync(BUILTINS_REFERENCE, 'utf8'),
  engineClaims: [
    {
      construct: 'text and number helpers (Text.trim/lower/upper/length/split/concat/from, Number.abs/round/floor/ceil/parse, List.compact, == null)',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

function \`Intake\`(m: <inbox-[:Email]->>) {
  n    = Number.parse(m.Subject)
  tags = List.compact("inbound", Text.split(m.Subject, ";"))
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        Text.upper(Text.trim(m.Subject))
    Description: Text.concat(Text.lower(m.From), " — ", Text.from(Number.abs(Number.round(1.6))), "/", Text.from(Number.floor(1.6)), "/", Text.from(Number.ceil(1.6)), " — ", Text.from(count(tags)))
    \`Team Size\` ?: n
  }
  big = Text.length(m.Body) > 500
  if (n == null) { fail("no number in the subject") }
}
`,
    },
    {
      construct: 'coalesce and exists (including a walk WHERE form)',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

function \`Intake\`(m: <inbox-[:Email]->>) {
  if (exists(m-[a:Attachments WHERE a.Name CONTAINS "pdf"]->)) {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: coalesce(m.From, "unknown")
    }
  }
}
`,
    },
    {
      construct: 'the commutative aggregates (count, only) over a captured relationship, plus Text.join/first/List.last/xs[n] each ordered inline with sort',
      status: 'runs',
      probe: `
import { \`@lf/attio\` as attio } from adapters
import { acme } from credentials

crm = connect attio using acme

function m(evt: <crm-[e:\`Webhook Event\` WHERE e.action == "record.created"]->>) {
  evt-[co:Companies]-> {
    names = co-[p:Team]-> { return p.Name }
    n     = count(co-[p:Team]->)
    owner = only(co-[t:Team WHERE t.\`Job Title\` == "CEO"]->)
    newest = first(sort(names))
    oldest = List.last(sort(names))
    head   = sort(names)[0]
    write co {
      Description: "\${n} people, \${Text.join(sort(names), ", ")}, \${coalesce(owner.Name, "no CEO")}, \${coalesce(newest, "")}/\${coalesce(oldest, "")}/\${coalesce(head, "")}"
    }
  }
}
`,
    },
    {
      construct: 'List.sum/avg/min/max over a list of numbers',
      status: 'runs',
      probe: `
import { \`@lf/attio\` as attio } from adapters
import { acme } from credentials

crm = connect attio using acme

function m(evt: <crm-[e:\`Webhook Event\` WHERE e.action == "record.created"]->>) {
  evt-[co:Companies]-> {
    amounts = [1200, 400, 900]
    total   = List.sum(amounts)
    average = List.avg(amounts)
    lowest  = List.min(amounts)
    highest = List.max(amounts)
    write co {
      \`Team Size\` ?: total
      Description: "\${average}/\${coalesce(Text.from(lowest), "")}/\${coalesce(Text.from(highest), "")}"
    }
  }
}
`,
    },
    {
      construct: 'map/filter/reduce/List.groupBy/List.keyBy, a bare no-return map statement, and indexing a dict literal vs a List.groupBy result',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

function \`Roster\`(go: <runs-[:Invocation]->>) {
  d = { bucket: "a", packed: 3 }
  lead = d.bucket

  rows   = crm-[p:People ORDER BY p.Name]-> { return { name: p.Name, title: p.\`Job Title\` } }
  lines  = map(rows, (r) => { return r.name })
  kept   = filter(lines, (t) => { return Text.length(t) > 0 })
  total  = reduce(kept, (carried, t) => { return carried + Text.length(t) }, 0)
  by     = List.groupBy(rows, (r) => { return r.title })
  byName = List.keyBy(rows, (r) => { return r.name })
  own    = byName["founder@acme.com"]
  ceos   = by.CEO

  map(rows, (r) => {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: r.name
    }
  })

  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        lead
    Description: "\${Text.join(kept, ", ")} (\${total} chars, has a founder entry: \${(own != null)}, groups: \${(ceos != null)})"
  }
}

listen to runs {} fire \`Roster\`
`,
    },
    {
      construct: 'members in declaration order, the c ? a : b conditional, and unary minus',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

runs = connect manual
chat = connect slack using team_workspace

type Thesis = <"Consumer" | "Infra" | "Health">

function \`Recap\`(go: <runs-[:Invocation]->>) {
  theses = members(<Thesis>)
  before = 10
  after  = 4
  delta  = -(after - before)
  lead   = theses[0]
  line   = lead != null ? "\${lead}" : ""

  ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  write ops-[:Messages]-> { Message: "\${Text.join(theses, ", ")} / \${line} / \${delta}" }
}

listen to runs {} fire \`Recap\`
`,
    },
    {
      construct: 'File.from/File.read/Text.chunks/pdf.render and the coercers Date.from/DateTime.from/Number.parse',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { \`@lf/pdf\` as pdf } from plugins
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

function \`Cut A Document\`(go: <runs-[:Invocation]->>) {
  go-[f:Files]-> {
    text   = File.read(f.File)
    pieces = Text.chunks(coalesce(text, ""), { size: 40000, overlap: 2000 })
    company = write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:          coalesce(first(pieces), "untitled")
      \`Team Size\` ?: Number.parse(coalesce(first(pieces), ""))
    }
    write company-[:Files]-> {
      File: pdf.render(Text.join(pieces, "\\n"))
    }
    write company-[:Notes]-> {
      Title:   "Window"
      Content: "\${Date.from(@current_date)} / \${DateTime.from(@current_date)}"
    }
  }
}

listen to runs {} fire \`Cut A Document\`
`,
    },
    {
      construct: 'namespace members: Currency.*, Date.*, DateTime.at/toIso, Text.regexExtract/slug, Url.host, Number.format',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

function \`Intake\`(m: <inbox-[:Email]->>) {
  today  = Date.today("Europe/Berlin")
  win    = DateTime.at(today, "07:00", "Europe/Berlin")
  ref    = Text.regexExtract(m.Subject, "(DEAL-\\\\d+)")
  amount = Currency.numberFromFigure(m.Body)
  company = write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        Text.slug(m.Subject)
    Description: Currency.codeFromFigure(m.Body)
    \`Team Size\` ?: amount
  }
  write company-[:Notes]-> {
    Title:   "Window"
    Content: "\${coalesce(Date.parse(m.Subject), Date.addDays(today, 7))} / \${Date.format(today, "MMMM D, YYYY")} / \${DateTime.toIso(win)} / \${coalesce(ref, "")} / \${coalesce(Url.host(m.Body), "")} / \${coalesce(Number.format(amount, "compact"), "")} / \${coalesce(Currency.formatFigure(amount, "EUR"), "")}"
  }
}
`,
    },
  ],
};
