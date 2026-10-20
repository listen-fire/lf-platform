// Which node-type categories the ontology agent may still create.
//
// `message` and `scoped_object` are deprecated — they belong to the retired
// message-rooted extraction-graph / scoping mechanism that automations
// (translation graphs) supersede. The agent must neither propose them nor
// be able to add them; only plain `object` types remain creatable. Property
// types are created through `createPropertyType`, not here.
//
// Pure + dependency-free so it can be unit-tested without dragging the DB
// (kysely/prisma) into the import graph.

import NodeTypeCategory from '../../generated/kysely/knowledge/NodeTypeCategory';

/**
 * Returns a clear, jargon-light reason string when the category can't be
 * created, or `null` when it's allowed. The reason is surfaced to the agent
 * (and, through it, the user) so it redirects instead of retrying.
 */
export function unsupportedCategoryReason(category: string): string | null {
  switch (category) {
    case NodeTypeCategory.object:
      return null;
    case NodeTypeCategory.message:
      return 'Incoming documents (emails, reports, notes) are no longer set up here — automations handle what comes in. Track the things mentioned in them as their own entities instead.';
    case NodeTypeCategory.scoped_object:
      return 'Entities scoped to a parent are no longer supported. Track it as a thing of its own and link it to its parent with a relationship.';
    default:
      return `"${category}" isn't a kind of thing you can add — set it up as a plain thing it tracks.`;
  }
}
