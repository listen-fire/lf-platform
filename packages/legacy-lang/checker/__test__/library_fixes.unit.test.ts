// A library's diagnostics surface on the file that imports it, at the import,
// but never with their fixes: a fix's edits are places in the LIBRARY's text,
// and applied to the importer's (as an upgrade applies every fix it is handed)
// they overwrite whatever the importer holds at those lines.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { ResolveFile } from '../link';

const chatSchema: InstanceSchema = {
  positions: {
    message: { properties: { Text: 'text' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} } },
};
const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

const LIBRARY = `import { \`@lf/slack\` as slack } from adapters
chat = connect slack
node Found: "the relevant information" {
  summary: <text> "a summary"
}
export function note(m: <chat-[:message]->>) {
  found = extractOne([m.Text], Found)
  write chat-[:note]-> { Body: found.summary }
}
`;
const resolveFile: ResolveFile = (path) => (path === 'lib/notes' ? { source: LIBRARY } : undefined);
const IMPORTER = 'import { note } from "lib/notes"\n';

const check = (source: string) =>
  checkProgram(parseProgram(source, { languageVersion: 5 }), catalog, { languageVersion: 5, resolveFile });

describe("a library's diagnostics on the file that imports it", () => {
  it('the library itself is offered the fix, at its own place', () => {
    const own = check(LIBRARY).find((d) => d.code === 'MOV_ABSENT_REQUIRED');
    expect(own?.fix?.edits[0]?.span.start.line).toBe(8);
  });

  it('surfaces on the importer, at the import, without the fix', () => {
    const surfaced = check(IMPORTER).filter((d) => d.code === 'MOV_ABSENT_REQUIRED');
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.message).toContain('"lib/notes" line 8');
    expect(surfaced[0]?.span.start.line).toBe(1);
    expect(surfaced[0]?.fix).toBeUndefined();
  });
});
