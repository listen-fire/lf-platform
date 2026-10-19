// Which of a target's required fields apply to an action in a given position.
//
// Certain target systems reject a write when a required field is unset (Attio
// `is_required` attributes, a KG node type's identity/unique property, …). The
// adapter contract surfaces this per field (`SchemaFieldDescriptor.required`);
// the engine's write-time check uses the subset that applies here.

import type { SchemaFieldDescriptor } from './types';

/**
 * The required fields that *apply* to an action in this position — writable
 * (an author can't satisfy a non-writable field) and not hidden in this
 * root/child context (a field the editor won't render can't be required of the
 * author here). A system-populated required field that is non-writable is not
 * the author's to satisfy, so it is excluded.
 */
export function applicableRequiredFields(input: {
  descriptorFields: SchemaFieldDescriptor[];
  isRoot: boolean;
}): SchemaFieldDescriptor[] {
  return input.descriptorFields.filter((f) => {
    if (!f.required || !f.writable) return false;
    if (f.hideOn === 'root' && input.isRoot) return false;
    if (f.hideOn === 'child' && !input.isRoot) return false;
    return true;
  });
}
