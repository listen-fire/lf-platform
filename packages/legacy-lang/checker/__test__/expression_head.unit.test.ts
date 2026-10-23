// A block head that starts at an EXPRESSION, typed.
//
// A record IS a value type, so one rule decides both roots: the head starts at
// whatever record the root holds, whether a name holds it or an expression
// does. `rows[0]-[f:Founders]-> { … }` types exactly as binding the call to
// a name and hopping off the name types, because that is the same fact read the
// same way.
//
// The refusals come with it. An expression whose value type is text has no
// position to hop from, and says so where it is WRITTEN. And `await` parks on
// the record it waits at, which a parked run has to find again by name — so the
// one head position that needs a name asks for one.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text' },
      edges: { Founders: { target: 'person', readable: true } },
    },
    person: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { Companies: { target: 'company' } },
  writableRoots: {},
};

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text' },
      edges: { Response: { target: 'message', readable: true, awaitable: true } },
    },
  },
  collections: { Messages: { target: 'message' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    attio: { constructionArgs: [], schema: crmSchema },
    email: { constructionArgs: [], schema: inboxSchema },
  },
});

const PRELUDE = `import { attio, email } from adapters
crm = connect attio
inbox = connect email
`;

function source(body: string): string {
  return `${PRELUDE}
function m(msg: <inbox-[:message]->>) {
${body}
}`;
}

function check(body: string): Diagnostic[] {
  return checkProgram(parseProgram(source(body)), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

/** `rows` is a list literal of records — ordered, so `AT` can index it —
 *  inside the guard that proves its one member there (from 5 a block's walk
 *  off a record that may be absent is refused); each body closes it. */
const ROWS =
  '  one = only(crm-[c:Companies WHERE c.`Name` == "Acme"]->)\n  if (one != null) {\n  rows = [one]\n';

describe('an expression head types as the record it holds', () => {
  it('a call picking one record out of a list', () => {
    expect(codes(`${ROWS}  rows[0]-[f:Founders]-> {\n    x = f.\`Name\`\n  }\n  }`)).toEqual([]);
  });

  it('exactly as binding it first does — the two forms are one walk', () => {
    const bound = codes(`${ROWS}  head = rows[0]\n  head-[f:Founders]-> {\n    x = f.\`Name\`\n  }\n  }`);
    const inline = codes(`${ROWS}  rows[0]-[f:Founders]-> {\n    x = f.\`Name\`\n  }\n  }`);
    expect(inline).toEqual(bound);
    expect(inline).toEqual([]);
  });

  it('a singleton fold over a narrowed walk may be absent, so from 5 the walk off it is refused', () => {
    expect(
      codes(
        '  only(crm-[c:Companies WHERE c.`Name` == "Acme"]->)-[f:Founders]-> {\n    x = f.`Name`\n  }',
      ),
    ).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a record held in a map, read by its key', () => {
    expect(
      codes(`${ROWS}  held = { a: rows[0] }\n  held.a-[f:Founders]-> {\n    x = f.\`Name\`\n  }\n  }`),
    ).toEqual([]);
  });

  it('the hop is typed off the expression, so an edge the record has not got is named', () => {
    expect(codes(`${ROWS}  rows[0]-[f:Investors]-> {\n    x = f.\`Name\`\n  }\n  }`)).toEqual([
      'MOV_TRAVERSE_UNKNOWN_EDGE',
    ]);
  });

  it('the landing is typed, so a property the landing has not got is named', () => {
    expect(codes(`${ROWS}  rows[0]-[f:Founders]-> {\n    x = f.\`Nope\`\n  }\n  }`)).toEqual([
      'MOV_UNKNOWN_PROPERTY',
    ]);
  });

  it('a name inside the expression is resolved — an unknown one is reported', () => {
    expect(codes('  AT(nope, 0)-[f:Founders]-> {\n    x = f.`Name`\n  }')).toContain(
      'MOV_NAME_UNRESOLVED',
    );
  });
});

describe('an expression that is not a record', () => {
  it('is refused at the head, naming the expression and what it is', () => {
    const body = '  AT(["a", "b"], 0)-[f:Founders]-> {\n    x = f.`Name`\n  }';
    expect(codes(body)).toContain('MOV_HEAD_NOT_A_POSITION');
    expect(messages(body)).toMatch(
      // A literal index into a literal reads a slot that is always there.
      /'AT\(\["a", "b"\], 0\)' is text, and a hop walks from a POSITION/,
    );
  });

  it('a name bound to the same value is refused identically', () => {
    const inline = messages('  AT(["a", "b"], 0)-[f:Founders]-> {\n    x = f.`Name`\n  }');
    const bound = messages('  s = AT(["a", "b"], 0)\n  s-[f:Founders]-> {\n    x = f.`Name`\n  }');
    expect(inline.replace(/'AT\(\["a", "b"\], 0\)'/, "'s'")).toBe(bound);
  });
});

describe("await parks on a record it can name again", () => {
  it('refuses an expression root, with the binding to make', () => {
    const body = `${ROWS}  answer = await first(rows[0]-[r:Founders]->)\n  }`;
    expect(codes(body)).toContain('MOV_HEAD_NEEDS_A_NAME');
    expect(messages(body)).toMatch(
      /'await' parks on the record it waits at, and a parked run finds that record again by NAME — so this one is bound first: 'waiting = rows\[0\]', then 'await first\(waiting-\[r:Founders\]->\)'/,
    );
  });

  it('a named root is untouched', () => {
    expect(codes('  answer = await FIRST(msg-[r:Response]->)')).not.toContain(
      'MOV_HEAD_NEEDS_A_NAME',
    );
  });
});

describe('the recording keeps the expression head the author wrote', () => {
  it('records the walk with no named root, its hop landed where the type walk put it', () => {
    const { recording } = checkProgramWithLink(
      parseProgram(source(`${ROWS}  rows[0]-[f:Founders]-> {\n    x = f.\`Name\`\n  }\n  }`)),
      catalog,
      { recordAnalysis: true },
    );
    const walks = (recording?.nodes ?? []).filter((node) => node.kind === 'traversal');
    expect(walks).toHaveLength(1);
    const [head] = walks;
    expect(head?.root).toBeUndefined();
    expect(head?.steps.map((step) => step.edgeTypeId)).toEqual(['Founders']);
    expect(head?.landings).toEqual([{ instance: 'crm', position: 'person' }]);
  });
});
