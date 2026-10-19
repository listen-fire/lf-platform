import type { SchemaFieldDescriptor } from 'engine-contracts/catalog';

import { applicableRequiredFields } from '../required_fields';

function field(over: Partial<SchemaFieldDescriptor> & { fieldId: string }): SchemaFieldDescriptor {
  return {
    displayName: over.fieldId,
    kind: 'string',
    writable: true,
    required: false,
    ...over,
  };
}

describe('applicableRequiredFields', () => {
  it('keeps only required fields', () => {
    const fields = [
      field({ fieldId: 'name', required: true }),
      field({ fieldId: 'notes', required: false }),
    ];
    expect(applicableRequiredFields({ descriptorFields: fields, isRoot: true }).map((f) => f.fieldId)).toEqual(['name']);
  });

  it('excludes non-writable required fields (author cannot satisfy them)', () => {
    const fields = [field({ fieldId: 'system_id', required: true, writable: false })];
    expect(applicableRequiredFields({ descriptorFields: fields, isRoot: true })).toHaveLength(0);
  });

  it('respects hideOn — a field hidden on children is not required there', () => {
    const fs = [field({ fieldId: 'connection', required: true, hideOn: 'child' })];
    expect(applicableRequiredFields({ descriptorFields: fs, isRoot: true })).toHaveLength(1);
    expect(applicableRequiredFields({ descriptorFields: fs, isRoot: false })).toHaveLength(0);
  });
});
