import { parseProgram } from 'legacy-lang';

import { movementWriteRunMode } from '../dry_run';

// Reproduces the shipped incident: a Slack instance constructed `dry_run: true`
// posted for real on a manual run. Two independent defects in the AST run-mode
// derivation, both exercised by the real movement shape:
//   (1) composition blindness — the fired movement delegates the write to a
//       called helper, so `movementWriteRunMode` sees zero writes → 'live';
//   (2) traversal-alias owner blindness — the edge-anchored messaging write
//       (`slackbot-[ch:Channels …]-> { write ch-[:messages]-> … }`) anchors on
//       a traversal alias whose owning instance isn't tracked → classified live.
describe('movementWriteRunMode — dry-run leak (incident repro)', () => {
  it('detects dry_run when the write is delegated to a called helper movement', () => {
    const source = `
import { manual, slack } from adapters
import { \`Slack (Listen-Fire)\` } from credentials

go = manual()
slackbot = slack(credentials: \`Slack (Listen-Fire)\`, dry_run: true)

movement Run() {
  slackbot-[ch:Channels WHERE \`Name\` == "daily"]-> {
    write ch-[:messages]-> {
      Message: "hi"
    }
  }
}

movement Manual(go_inv: <go-[:Invocation]->>) {
  Run()
}

listen to go {} fire Manual
`;
    const mode = movementWriteRunMode(parseProgram(source), 'Manual');
    expect(mode.mode).toBe('dry_run');
  });

  it('detects dry_run for the edge-anchored write even when inlined (traversal-alias owner)', () => {
    const source = `
import { manual, slack } from adapters
import { \`Slack (Listen-Fire)\` } from credentials

go = manual()
slackbot = slack(credentials: \`Slack (Listen-Fire)\`, dry_run: true)

movement Manual(go_inv: <go-[:Invocation]->>) {
  slackbot-[ch:Channels WHERE \`Name\` == "daily"]-> {
    write ch-[:messages]-> {
      Message: "hi"
    }
  }
}

listen to go {} fire Manual
`;
    const mode = movementWriteRunMode(parseProgram(source), 'Manual');
    expect(mode.mode).toBe('dry_run');
  });

  it('still reads live when the instance is not dry_run (no false rehearsal)', () => {
    const source = `
import { manual, slack } from adapters
import { \`Slack (Listen-Fire)\` } from credentials

go = manual()
slackbot = slack(credentials: \`Slack (Listen-Fire)\`)

movement Run() {
  slackbot-[ch:Channels WHERE \`Name\` == "daily"]-> {
    write ch-[:messages]-> { Message: "hi" }
  }
}

movement Manual(go_inv: <go-[:Invocation]->>) { Run() }

listen to go {} fire Manual
`;
    expect(movementWriteRunMode(parseProgram(source), 'Manual').mode).toBe('live');
  });

  it('reads mixed when a dry instance and a live instance are both written (through a helper)', () => {
    const source = `
import { manual, slack, attio } from adapters
import { \`Slack (Listen-Fire)\`, acme } from credentials

go = manual()
slackbot = slack(credentials: \`Slack (Listen-Fire)\`, dry_run: true)
crm = attio(credentials: acme)

movement Run() {
  slackbot-[ch:Channels WHERE \`Name\` == "daily"]-> {
    write ch-[:messages]-> { Message: "hi" }
  }
  write crm-[:\`Companies\`]-> { Name: "Acme" }
}

movement Manual(go_inv: <go-[:Invocation]->>) { Run() }

listen to go {} fire Manual
`;
    expect(movementWriteRunMode(parseProgram(source), 'Manual').mode).toBe('mixed');
  });
});
