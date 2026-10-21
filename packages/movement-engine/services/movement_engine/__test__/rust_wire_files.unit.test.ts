// The host walk over a parked state and a branch's exports, as the Rust
// engine's wire hands them back: a file is made only where the park's
// structure says one is, never by a binding's name or a value's shape.

import { isFileValue } from 'engine-contracts';
import { filesInBranchExports, filesInParkState } from '../rust_wire';

const SPELLED = { __brand: 'FileRef', name: 'secrets.pdf', source: { store: 'document', objectUri: 's3://bucket/another-team/secrets.pdf' } };

describe('a parked file is found by the park\'s structure, never by a name', () => {
  const NAMES = ['fields', 'body', 'head', 'position', 'op', 'mapping', 'closure', 'params', 'origin', 'handle'];

  it('the host walk makes a file only where the structure says one is', () => {
    const fileValue = { kind: 'file', file: SPELLED };
    const binding = { kind: 'recordValue', value: fileValue };
    const state = {
      version: 1,
      address: 'a',
      bindingName: null,
      scopeChain: [
        {
          bindings: {
            ...Object.fromEntries(NAMES.map((name) => [name, binding])),
            // Data whatever its shape: a value, a data member, a record's
            // fields, an edge's properties, a written record.
            plain: { kind: 'value', value: fileValue },
            data: { kind: 'recordValue', value: { kind: 'map', of: { x: { kind: 'data', value: fileValue } } } },
            shaped: {
              kind: 'shapePosition', shape: 's', node: 'n', fields: { deck: fileValue, other: fileValue },
              fileFields: { deck: fileValue }, fieldProvenance: {},
            },
            edge: { kind: 'sourcePosition', position: { data: fileValue }, edgeProperties: { p: fileValue } },
            written: { kind: 'handle', handle: { fields: { deck: fileValue } }, targetType: 't', graph: {} },
            unknown: { kind: 'notAKindYet', fields: fileValue, file: SPELLED },
          },
        },
      ],
    };
    const made = filesInParkState(JSON.parse(JSON.stringify(state))) as typeof state;
    const bindings = made.scopeChain[0]!.bindings as Record<string, any>;
    for (const name of NAMES) expect(isFileValue(bindings[name].value.file)).toBe(true);
    expect(bindings.plain).toEqual(state.scopeChain[0]!.bindings.plain);
    expect(bindings.data).toEqual(state.scopeChain[0]!.bindings.data);
    expect(bindings.edge).toEqual(state.scopeChain[0]!.bindings.edge);
    expect(bindings.written).toEqual(state.scopeChain[0]!.bindings.written);
    expect(bindings.unknown).toEqual(state.scopeChain[0]!.bindings.unknown);
    expect(bindings.shaped.fields).toEqual({ deck: fileValue, other: fileValue });
    expect(isFileValue(bindings.shaped.fileFields.deck.file)).toBe(true);

    // A branch's exports are its names' descriptors, whatever the names.
    const rows = filesInBranchExports([
      { branchAddress: 'b0', branchIndex: 0, exports: { kept: binding, source: binding, plain: { kind: 'value', value: fileValue } } },
      { branchAddress: 'b1', branchIndex: 1, exports: { kept: true, answer: binding } },
      { branchAddress: 'f', branchIndex: -1, exports: { arms: 2 } },
    ]) as Array<{ exports: Record<string, any> }>;
    expect(isFileValue(rows[0]!.exports.kept.value.file)).toBe(true);
    expect(isFileValue(rows[0]!.exports.source.value.file)).toBe(true);
    expect(rows[0]!.exports.plain).toEqual({ kind: 'value', value: fileValue });
    expect(isFileValue(rows[1]!.exports.answer.value.file)).toBe(true);
    expect(rows[2]!.exports).toEqual({ arms: 2 });
  });
});
