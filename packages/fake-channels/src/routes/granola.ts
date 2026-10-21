import { Router } from 'express';
import type { EntityStore } from '../store';

const SVC = 'granola';

/**
 * Fake Granola public API — the two endpoints `GranolaClient` (apps/api
 * adapters/granola/client.ts) calls:
 *
 *   GET /v1/notes?updated_after=&cursor=&page_size=  → { notes: summary[], hasMore, cursor }
 *   GET /v1/notes/:id?include=transcript             → the full note
 *
 * Notes are seeded (full shape) via the generic admin seed route
 * (`POST /admin/granola/seed` with entity_type `note`); `dev:inject granola`
 * builds a complete note from flags and seeds it, then fires the poll in-process.
 *
 * The list route projects each stored full note down to the SUMMARY shape the
 * client's `listNotes`/`listAllNotes` parse, honouring `updated_after` (the poll
 * checkpoint). `getNote` returns the stored note verbatim — its summary/transcript/
 * attendees are what `normalizeNote` flattens. The Bearer token is not validated
 * (the dev-loop credential is a stub; identity isn't the thing under test here).
 */

interface GranolaUser {
  name: string | null;
  email: string;
}

interface StoredNote {
  id: string;
  object: 'note';
  title: string | null;
  owner: GranolaUser;
  created_at: string;
  updated_at: string;
  calendar_event: unknown | null;
  attendees: GranolaUser[];
  folder_membership: { id: string; name: string }[];
  summary_text: string;
  summary_markdown: string | null;
  transcript: unknown[] | null;
}

/** Project a stored full note down to the summary shape `listNotes` returns. */
function toSummary(n: StoredNote) {
  return {
    id: n.id,
    object: 'note' as const,
    title: n.title,
    owner: n.owner,
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

export function granolaRoutes(store: EntityStore): Router {
  const r = Router();

  // List note summaries updated since `updated_after`, newest paging is not
  // needed for the dev loop — return everything in one page (hasMore=false).
  r.get('/v1/notes', (req, res) => {
    const updatedAfter =
      typeof req.query.updated_after === 'string' ? req.query.updated_after : undefined;
    const notes = store
      .list(SVC, 'note')
      .map((e) => e.data as unknown as StoredNote)
      .filter((n) => !updatedAfter || n.updated_at > updatedAfter)
      .map(toSummary);
    res.json({ notes, hasMore: false, cursor: null });
  });

  // Fetch one note in full (the client appends `?include=transcript`).
  r.get('/v1/notes/:id', (req, res) => {
    const row = store.get(SVC, 'note', req.params.id);
    if (!row) return res.status(404).json({ error: 'Note not found' });
    res.json(row.data);
  });

  return r;
}
