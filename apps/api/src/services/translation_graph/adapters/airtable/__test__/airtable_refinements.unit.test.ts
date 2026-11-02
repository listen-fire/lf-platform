// Airtable through the platform's own narrowing pass (the module's unit tests
// cover the adapter; this pass is the host's). The fake Airtable is the
// module's own test double.

import { scanInstanceChains } from 'legacy-lang';
import { LANGUAGE_VERSION } from 'movement-lang';

import type { AirtableAdapter } from '@listen-fire/airtable';

import { dealsTable, makeMultiBaseAdapter, tasksTable } from '@listen-fire/airtable/testing';
import { instanceSchemaFromDescriptors, makeMetaPosition, positionData, type SourcePosition } from 'movement-engine/public/catalog';
import { refineInstanceSchema } from '../../../movement/refinements';

describe('the table write promise reaches the CHECKER projection, through the host refinement', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const ops = () => ({ id: 'appOPS01', name: 'Ops', tables: [tasksTable()] });

  /** The unpositioned instance's schema exactly as the catalog assembles it:
   *  the published entries, each described, through the real projection. */
  async function projectUnpositioned(adapter: AirtableAdapter) {
    const entries = await adapter.listEntryPoints();
    const described = await Promise.all(
      entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
    );
    const projection = instanceSchemaFromDescriptors({
      adapterType: 'airtable',
      entries,
      descriptors: new Map(described.flatMap(([id, d]) => (d ? [[id, d] as const] : []))),
      supportsInPlaceUpdate: false,
    });
    return { entries, projection };
  }

  const source = `air = connect \`@lf/airtable\` using airtable_cred
function put(go: <manual-[:Invocations]->>) {
  air-[b:Bases WHERE b.Name == "CRM"]-> {
    write b-[:\`Deals\`]-> { Name: "X" }
  }
}
listen to manual-[:Invocations]-> fire put
`;

  it('a narrowed base\'s table edge is writable at the checker', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-checker-write',
      bases: [crm(), ops()],
    });
    const { entries, projection } = await projectUnpositioned(adapter);

    // The refined position the checker looks up — produced by the same
    // `refineInstanceSchema` the catalog runs, off the real `describe('CRM')`.
    const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));
    const { schema } = await refineInstanceSchema({
      instance: {
        adapterType: 'airtable',
        schema: projection.schema,
        entryPoints: entries.map((e) => ({
          typeId: e.typeId,
          displayName: e.displayName,
          writable: e.writable === true,
          readable: e.readable === true,
        })),
        describeType: (typeName: string) => adapter.describe(typeName),
        membersOf: async () =>
          Object.values(hop?.targetPositions ?? {}).map((position) => {
            const data = positionData(position) as { Name: string };
            return { name: data.Name, data };
          }),
      },
      chains: scanInstanceChains(source, { languageVersion: LANGUAGE_VERSION }),
    });

    const refined = schema.positions['Base "CRM"'];
    expect(refined).toBeDefined();
    expect(refined!.edges.Deals).toMatchObject({ target: 'Deals', writable: true });
  });


  /** The walk the catalog's cached instance makes: paths filed by name as
   *  each hop hands them over, a landing reached along its parent's path. */
  function walker(adapter: AirtableAdapter) {
    const paths = new Map<string, SourcePosition>();
    const hop = async (position: SourcePosition) => {
      const answer = await adapter.edgesFrom(position);
      for (const [fieldId, target] of Object.entries(answer?.targetPositions ?? {})) {
        const named = answer?.descriptor.references.find((reference) => reference.fieldId === fieldId)?.targetTypeId;
        const label = named ?? (positionData(target) as { Name?: string }).Name;
        if (label !== undefined) paths.set(label, target);
      }
      return answer;
    };
    const root = hop(makeMetaPosition('airtable'));
    return {
      describeType: async (name: string) => {
        await root;
        const at = paths.get(name);
        return at !== undefined ? ((await hop(at))?.descriptor ?? null) : adapter.describe(name);
      },
      describeLanding: async (from: string, target: string) => {
        await root;
        const at = paths.get(from);
        if (at === undefined) return null;
        const parent = await hop(at);
        const edge = parent?.descriptor.references.find((reference) => reference.targetTypeId === target);
        const position = edge !== undefined ? parent?.targetPositions?.[edge.fieldId] : undefined;
        return position !== undefined ? ((await hop(position))?.descriptor ?? null) : null;
      },
      rootMembers: async () => {
        const answer = await root;
        return Object.values(answer?.targetPositions ?? {}).flatMap((position) => {
          const name = (positionData(position) as { Name?: string }).Name;
          return name !== undefined && position.recordType !== null ? [{ name, recordType: position.recordType }] : [];
        });
      },
      membersOf: async () => {
        const answer = await root;
        return Object.values(answer?.targetPositions ?? {}).map((position) => {
          const data = positionData(position) as { Name: string };
          return { name: data.Name, data };
        });
      },
    };
  }

  const listening = `at = connect \`@lf/airtable\` using airtable_cred
function intake(c: <at-[:\`Deals Change\`]->>) {
  c-[r:Record]-> { }
}
listen to at-[b:Bases WHERE b.Name == "CRM"]->-[t:Tables WHERE t.Name == "Deals"]->-[c:Changes WHERE c.Kind == "created"]-> fire intake
`;

  it("a narrowed base keeps the base's own Name, and its tables' changes are typed", async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-listen', bases: [crm(), ops()] });
    const { entries, projection } = await projectUnpositioned(adapter);
    const { schema } = await refineInstanceSchema({
      instance: {
        adapterType: 'airtable',
        schema: projection.schema,
        entryPoints: entries.map((e) => ({ typeId: e.typeId, displayName: e.displayName, writable: e.writable === true, readable: e.readable === true })),
        ...walker(adapter),
      },
      chains: scanInstanceChains(listening, { languageVersion: LANGUAGE_VERSION }),
    });

    expect(schema.positions['Base "CRM"']?.properties).toHaveProperty('Name');
    expect(schema.positions['Deals Change']).toBeDefined();
    expect(schema.positions['Deals Change']?.undescribed).not.toBe(true);
    expect(schema.positions['Deals Change']?.edges.Record).toMatchObject({ target: 'Deals' });
  });

  it("a record type a parameter names is found off the member that lands on it", async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-named', bases: [crm(), ops()] });
    const { entries, projection } = await projectUnpositioned(adapter);
    const onlyTheParameter = listening.split('\nlisten to')[0] ?? '';
    const { schema } = await refineInstanceSchema({
      instance: {
        adapterType: 'airtable',
        schema: projection.schema,
        entryPoints: entries.map((e) => ({ typeId: e.typeId, displayName: e.displayName, writable: e.writable === true, readable: e.readable === true })),
        ...walker(adapter),
      },
      chains: scanInstanceChains(onlyTheParameter, { languageVersion: LANGUAGE_VERSION }),
    });

    expect(schema.positions['Deals Change']?.edges.Record).toMatchObject({ target: 'Deals' });
  });
});
