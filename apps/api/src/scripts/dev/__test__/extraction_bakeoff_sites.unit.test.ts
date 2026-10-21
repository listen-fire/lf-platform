// The bake-off's dry run reports how many extraction sites the root call
// carries — the tally that decides the model. A node that takes a declaration
// as its shape writes no first stage of its own, so the tally must come from
// the planned spec, where the declaration IS that first stage.

import { type ExtractExpression, type ShapeNode } from 'movement-lang';
import { parseProgram } from 'movement-lang';

import { fixtureSpec, rootSites } from '../extraction_bakeoff';

const DECLARATION = [
  'node Entry: "each company" {',
  '  name: <text> "its name"',
  '  node founder: "each founder" {',
  '    first: <text> "given names"',
  '    node school: "each school" { name: <text> "its name" }',
  '  }',
  '}',
].join('\n');

/** The one extract in `m`'s body, and the declarations the file makes. */
function parsed(tree: string): { extract: ExtractExpression; shapes: Map<string, ShapeNode> } {
  const program = parseProgram(
    [DECLARATION, 'movement m() {', `  found = extract from [x] { ${tree} }`, '}'].join('\n'),
  );
  const shapes = new Map<string, ShapeNode>();
  let extract: ExtractExpression | undefined;
  for (const statement of program.statements) {
    if (statement.kind === 'shape') shapes.set(statement.name, statement.root);
    if (statement.kind === 'movement') {
      const first = statement.body[0];
      if (first?.kind === 'assign' && first.value.kind === 'extract') extract = first.value.extract;
    }
  }
  if (extract === undefined) throw new Error('expected an extract');
  return { extract, shapes };
}

async function sitesOf(tree: string): Promise<number> {
  const { extract, shapes } = parsed(tree);
  const spec = await fixtureSpec(extract, {
    resolveDeclaredNode: (type) => {
      const root = shapes.get(type);
      return root === undefined
        ? undefined
        : {
            root,
            resolveDeclaredType: () => undefined,
            resolveDescription: async () => {
              throw new Error('these words interpolate nothing');
            },
          };
    },
  });
  return rootSites(spec);
}

describe('the bake-off root site tally', () => {
  it("counts a declared node's nested nodes, as the inline block's", async () => {
    const inline = [
      'node entry: "each company" {',
      '  name: <text> "its name"',
      '  node founder: "each founder" {',
      '    first: <text> "given names"',
      '    node school: "each school" { name: <text> "its name" }',
      '  }',
      '}',
    ].join('\n');
    expect(await sitesOf(inline)).toBe(4);
    expect(await sitesOf('node entry: <Entry>')).toBe(4);
  });

  it('keeps a declared node in the root call when a `through` stage follows it', async () => {
    // The declaration is the unfenced first stage; the plugin fences only the
    // stage after it.
    expect(
      await sitesOf('node entry: <Entry> through [lookup(q: name)] { stage: "from the lookup" }'),
    ).toBe(4);
  });
});
