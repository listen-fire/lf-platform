import express, { Router } from 'express';
import type { EntityStore } from '../store';

const SVC = 'affinity';

/** GET /interactions keys its array by the interaction kind. Only `emails`
 *  (type 3) is documented; the other keys mirror the resource names. */
const INTERACTION_ENVELOPE_KEY: Record<string, string> = {
  '0': 'events',
  '1': 'calls',
  '2': 'chat_messages',
  '3': 'emails',
};

/** Affinity guarantees at most one person per email address across the team's
 *  contact list, and rejects a write that would break it. Reproduced here
 *  because a fake that silently accepts duplicates cannot exercise the
 *  reconcile-vs-create path at all.
 *
 *  Conflict detection folds case, deliberately. Affinity's exact normalization
 *  rule is not documented and we have not measured it — but a live create was
 *  rejected for an address our own exact-string search had just returned and
 *  walked past, so the rule is at least broader than `===`. Treating addresses
 *  case-insensitively is the prudent floor: it costs nothing if Affinity is
 *  stricter than this, and it is the correct reading of an email address
 *  either way.
 *
 *  If the real rule turns out broader still (aliases, plus-addressing, dots),
 *  widen this. The standing lesson is that our search cannot predict
 *  Affinity's constraint, so we should not model it narrowly. */
/** Affinity v1 pages every collection endpoint the same way: `page_size` caps
 *  the page (500 is both the default and the maximum) and `next_page_token`
 *  comes back exactly while more remain, to be sent back as `page_token`.
 *
 *  Reproduced here because a fake that answers every read in one page makes a
 *  client that stops after page one look CORRECT — the truncation only appears
 *  against a workspace with a 501st record, which is precisely the workspace
 *  nobody tests against. The token is an offset, which a fake may do and the
 *  real API may not: it is opaque to the client either way.
 */
const AFFINITY_PAGE_SIZE = 500;

function page<T>(rows: T[], query: express.Request['query']): { rows: T[]; next_page_token?: string } {
  const size = Math.min(Number(query.page_size) || AFFINITY_PAGE_SIZE, AFFINITY_PAGE_SIZE);
  const start = Number(query.page_token) || 0;
  const next = start + size;
  return {
    rows: rows.slice(start, next),
    ...(next < rows.length ? { next_page_token: String(next) } : {}),
  };
}

function emailOwner(store: EntityStore, emails: unknown): string | null {
  const incoming = (Array.isArray(emails) ? emails : [])
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim().toLowerCase());
  if (!incoming.length) return null;

  for (const person of store.list(SVC, 'person')) {
    const owned = (person.data.emails as string[] | undefined) ?? [];
    if (owned.some((e) => incoming.includes(e.trim().toLowerCase()))) return String(person.id);
  }
  return null;
}

function emailConflict(res: express.Response) {
  return res.status(422).json(['There exists a contact with this email address.']);
}

export function affinityRoutes(store: EntityStore): Router {
  const r = Router();

  /** An entity's memberships, as Affinity returns them INLINE on the entity.
   *  Derived from the entries themselves rather than stored on the record: a
   *  stored copy went stale the moment an entry was created, which made every
   *  membership look new and hid the dedup path entirely. */
  const listEntriesOf = (entityId: string) =>
    store
      .list(SVC, 'list')
      .flatMap((l) => store.list(SVC, `list_entry:${l.id}`))
      .filter((e) => String(e.data.entity_id) === entityId)
      .map((e) => ({ id: Number(e.id), ...e.data }));

  // Organizations
  r.get('/organizations', (req, res) => {
    const term = (req.query.term as string)?.toLowerCase();
    let orgs = store.list(SVC, 'organization');
    if (term) {
      orgs = orgs.filter(
        (o) =>
          (o.data.name as string)?.toLowerCase().includes(term) ||
          (o.data.domain as string)?.toLowerCase().includes(term),
      );
    }
    const { rows, next_page_token } = page(orgs, req.query);
    res.json({
      organizations: rows.map((o) => ({ id: Number(o.id), ...o.data })),
      ...(next_page_token ? { next_page_token } : {}),
    });
  });

  r.get('/organizations/:id', (req, res) => {
    const org = store.get(SVC, 'organization', req.params.id);
    if (!org) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(org.id), ...org.data, list_entries: listEntriesOf(req.params.id) });
  });

  r.post('/organizations', (req, res) => {
    const id = store.nextId(SVC, 'organization');
    const org = store.create(
      SVC,
      'organization',
      {
        name: req.body.name,
        domain: req.body.domain || null,
        domains: req.body.domain ? [req.body.domain] : [],
        person_ids: [],
        global: false,
      },
      id,
    );
    res.json({ id: Number(org.id), ...org.data });
  });

  r.put('/organizations/:id', (req, res) => {
    const org = store.update(SVC, 'organization', req.params.id, req.body);
    if (!org) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(org.id), ...org.data });
  });

  // Persons
  r.get('/persons', (req, res) => {
    const term = (req.query.term as string)?.toLowerCase();
    let persons = store.list(SVC, 'person');
    if (term) {
      persons = persons.filter((p) => {
        const first = (p.data.first_name as string)?.toLowerCase() ?? '';
        const last = (p.data.last_name as string)?.toLowerCase() ?? '';
        const fullName = [first, last].filter(Boolean).join(' ');
        return (
          first.includes(term) ||
          last.includes(term) ||
          term.includes(first) ||
          term.includes(last) ||
          fullName === term ||
          (p.data.primary_email as string)?.toLowerCase().includes(term) ||
          (p.data.emails as string[])?.some((e) => e.toLowerCase().includes(term))
        );
      });
    }
    const { rows, next_page_token } = page(persons, req.query);
    res.json({
      persons: rows.map((p) => ({ id: Number(p.id), ...p.data })),
      ...(next_page_token ? { next_page_token } : {}),
    });
  });

  r.get('/persons/:id', (req, res) => {
    const person = store.get(SVC, 'person', req.params.id);
    if (!person) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(person.id), ...person.data, list_entries: listEntriesOf(req.params.id) });
  });

  r.post('/persons', (req, res) => {
    const conflict = emailOwner(store, req.body.emails);
    if (conflict) return emailConflict(res);

    const id = store.nextId(SVC, 'person');
    const person = store.create(
      SVC,
      'person',
      {
        first_name: req.body.first_name,
        last_name: req.body.last_name,
        primary_email: req.body.emails?.[0] || null,
        emails: req.body.emails || [],
        organization_ids: req.body.organization_ids || [],
      },
      id,
    );
    res.json({ id: Number(person.id), ...person.data });
  });

  r.put('/persons/:id', (req, res) => {
    const conflict = emailOwner(store, req.body.emails);
    if (conflict && conflict !== req.params.id) return emailConflict(res);

    const person = store.update(SVC, 'person', req.params.id, req.body);
    if (!person) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(person.id), ...person.data });
  });

  // Lists
  // Deletes (Affinity v1 has first-class deletes; return { success: true }).
  r.delete('/organizations/:id', (req, res) => {
    store.delete(SVC, 'organization', req.params.id);
    res.json({ success: true });
  });

  r.delete('/persons/:id', (req, res) => {
    store.delete(SVC, 'person', req.params.id);
    res.json({ success: true });
  });

  r.delete('/lists/:listId/list-entries/:entryId', (req, res) => {
    store.delete(SVC, `list_entry:${req.params.listId}`, req.params.entryId);
    res.json({ success: true });
  });

  r.delete('/notes/:id', (req, res) => {
    store.delete(SVC, 'note', req.params.id);
    res.json({ success: true });
  });

  /** The workspace the API key belongs to. The adapter reads it for ONE thing —
   *  the `<subdomain>.affinity.co` prefix every record url is built from — and
   *  a fake that 404s it made that one call look free, so a cache over it could
   *  not be measured at all. */
  r.get('/auth/whoami', (_req, res) => {
    res.json({
      tenant: { id: 1, name: 'Fake Channels', subdomain: 'fake' },
      user: { id: 1, firstName: 'Fake', lastName: 'User', email: 'fake@example.test' },
      grant: { type: 'api-key', scope: 'full', createdAt: '2020-01-01T00:00:00Z' },
    });
  });

  r.get('/lists', (_req, res) => {
    const lists = store.list(SVC, 'list');
    res.json(lists.map((l) => ({ id: Number(l.id), ...l.data })));
  });

  r.get('/lists/:id', (req, res) => {
    const list = store.get(SVC, 'list', req.params.id);
    if (!list) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(list.id), ...list.data });
  });

  // List Entries
  r.get('/lists/:listId/list-entries', (req, res) => {
    const entries = store.list(SVC, `list_entry:${req.params.listId}`);
    res.json(entries.map((e) => ({ id: Number(e.id), ...e.data })));
  });

  r.get('/lists/:listId/list-entries/:entryId', (req, res) => {
    const entry = store.get(SVC, `list_entry:${req.params.listId}`, req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(entry.id), ...entry.data });
  });

  r.post('/lists/:listId/list-entries', (req, res) => {
    const id = store.nextId(SVC, `list_entry:${req.params.listId}`);
    const entry = store.create(
      SVC,
      `list_entry:${req.params.listId}`,
      {
        list_id: Number(req.params.listId),
        entity_id: req.body.entity_id,
        created_at: new Date().toISOString(),
      },
      id,
    );
    res.json({ id: Number(entry.id), ...entry.data });
  });

  // Fields
  //
  // `with_modified_names=true` (which the adapter always asks for) is what makes
  // Affinity put `[<list>] ` in front of a list-scoped field's name. The fake
  // stored the bare name and ignored the flag, so nothing here ever saw the
  // prefix the real API returns — and the per-list type's names were tested
  // against a shape production does not have.
  r.get('/fields', (req, res) => {
    let fields = store.list(SVC, 'field');
    const entityType = req.query.entity_type as string | undefined;
    const listId = req.query.list_id as string | undefined;
    const modifiedNames = req.query.with_modified_names === 'true';
    if (entityType !== undefined) {
      fields = fields.filter((f) => String(f.data.entity_type) === entityType);
    }
    if (listId) {
      fields = fields.filter((f) => f.data.list_id === null || String(f.data.list_id) === listId);
    }
    const listNameById = new Map(
      store.list(SVC, 'list').map((l) => [Number(l.id), String(l.data.name ?? '')]),
    );
    res.json(
      fields.map((f) => {
        const list = f.data.list_id == null ? undefined : listNameById.get(Number(f.data.list_id));
        const name =
          modifiedNames && list ? `[${list}] ${String(f.data.name)}` : String(f.data.name);
        return { id: Number(f.id), ...f.data, name };
      }),
    );
  });

  // Field Values
  //
  // A field-value row on the real API carries its field's `value_type` and a
  // nullable `list_entry_id`, and a RANKED_DROPDOWN (7) value is the whole
  // option OBJECT (`{id, rank, text}`), not a bare id. The store keeps rows in
  // their minimal authored form, so the response is built up to that real shape
  // here — a client that validates the documented response (ours does) must be
  // able to parse what this fake returns.
  const dressFieldValue = (row: { id: string | number; data: Record<string, unknown> }) => {
    const field = store.get(SVC, 'field', String(row.data.field_id));
    const valueType = field?.data.value_type as number | undefined;
    const options = (field?.data.dropdown_options ?? null) as
      | { id: number; text: string; rank: number }[]
      | null;

    let value = row.data.value ?? null;
    if (valueType === 7 && typeof value === 'number') {
      const option = options?.find((o) => o.id === value);
      if (option) value = { id: option.id, rank: option.rank, text: option.text };
    }

    return {
      ...row.data,
      id: Number(row.id),
      entity_id: row.data.entity_id as number | undefined,
      list_entry_id: (row.data.list_entry_id as number | null | undefined) ?? null,
      entity_type: (row.data.entity_type as number | undefined) ?? (field?.data.entity_type as number | undefined) ?? 0,
      value_type: valueType ?? 6,
      value,
    };
  };

  r.get('/field-values', (req, res) => {
    const personId = req.query.person_id as string | undefined;
    const orgId = req.query.organization_id as string | undefined;
    const listEntryId = req.query.list_entry_id as string | undefined;

    // Dress first, then filter: a list-entry row carries no `entity_type` of
    // its own, so it only discriminates correctly once its field's type has
    // been filled in.
    const values = store.list(SVC, 'field_value').map(dressFieldValue).filter((v) => {
      // Entity-scoped queries also return the entity's LIST-ENTRY rows, as the
      // real API does — callers filter by `list_entry_id` themselves.
      if (personId && String(v.entity_id) === personId && v.entity_type === 0) return true;
      if (orgId && String(v.entity_id) === orgId && v.entity_type === 1) return true;
      if (listEntryId && String(v.list_entry_id) === listEntryId) return true;
      return false;
    });
    res.json(values);
  });

  r.post('/field-values', (req, res) => {
    const id = store.nextId(SVC, 'field_value');
    const fv = store.create(SVC, 'field_value', req.body, id);
    res.json({ id: Number(fv.id), ...fv.data });
  });

  r.put('/field-values/:id', (req, res) => {
    const fv = store.update(SVC, 'field_value', req.params.id, req.body);
    if (!fv) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(fv.id), ...fv.data });
  });

  // A value row IS the value, so removing the row is how a field is emptied —
  // what `unlink` does to a reference.
  r.delete('/field-values/:id', (req, res) => {
    store.delete(SVC, 'field_value', req.params.id);
    res.json({ success: true });
  });

  // Notes — GET /notes is workspace-wide with optional person/organization/
  // opportunity scoping (the real API's shape).
  r.get('/notes', (req, res) => {
    const orgId = req.query.organization_id as string | undefined;
    const personId = req.query.person_id as string | undefined;
    const opportunityId = req.query.opportunity_id as string | undefined;
    const notes = store.search(SVC, 'note', (d) => {
      if (orgId) return ((d.organization_ids as number[]) ?? []).includes(Number(orgId));
      if (personId) return ((d.person_ids as number[]) ?? []).includes(Number(personId));
      if (opportunityId) return ((d.opportunity_ids as number[]) ?? []).includes(Number(opportunityId));
      return true;
    });
    res.json({ notes: notes.map((n) => ({ id: Number(n.id), ...n.data })), next_page_token: null });
  });

  r.get('/notes/:id', (req, res) => {
    const note = store.get(SVC, 'note', req.params.id);
    if (!note) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(note.id), ...note.data });
  });

  r.post('/notes', (req, res) => {
    const id = store.nextId(SVC, 'note');
    const parentId = req.body.parent_id != null ? Number(req.body.parent_id) : null;
    const note = store.create(
      SVC,
      'note',
      {
        // Real-API reply semantics: a reply carries NO entity associations —
        // only the parent note does.
        organization_ids: parentId != null ? [] : (req.body.organization_ids ?? []),
        person_ids: parentId != null ? [] : (req.body.person_ids ?? []),
        opportunity_ids: parentId != null ? [] : (req.body.opportunity_ids ?? []),
        parent_id: parentId,
        content: req.body.content,
        type: req.body.type ?? 0,
        creator_id: 1,
        created_at: new Date().toISOString(),
        updated_at: null,
      },
      id,
    );
    res.json({ id: Number(note.id), ...note.data });
  });

  // Entity Files — GET /entity-files is workspace-wide with optional
  // person/organization/opportunity scoping; POST is multipart (file +
  // exactly one parent id field).
  r.get('/entity-files', (req, res) => {
    const orgId = req.query.organization_id as string | undefined;
    const personId = req.query.person_id as string | undefined;
    const opportunityId = req.query.opportunity_id as string | undefined;
    const files = store.search(SVC, 'file', (d) => {
      if (orgId) return Number(d.organization_id) === Number(orgId);
      if (personId) return Number(d.person_id) === Number(personId);
      if (opportunityId) return Number(d.opportunity_id) === Number(opportunityId);
      return true;
    });
    res.json({
      entity_files: files.map((f) => ({ id: Number(f.id), ...f.data })),
      next_page_token: null,
    });
  });

  r.get('/entity-files/:id', (req, res) => {
    const file = store.get(SVC, 'file', req.params.id);
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(file.id), ...file.data });
  });

  const rawBody = express.raw({ type: 'multipart/form-data', limit: '50mb' });
  r.post('/entity-files', rawBody, (req, res) => {
    // Parse the multipart body by hand (the gdrive route's precedent): pull
    // the parent id field and the file part's filename/size.
    const contentType = String(req.headers['content-type'] ?? '');
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]?.replace(/^"|"$/g, '');
    const fields: Record<string, string> = {};
    let fileName: string | null = null;
    let fileSize = 0;
    if (boundary && Buffer.isBuffer(req.body)) {
      const raw = req.body.toString('utf-8');
      for (const part of raw.split(`--${boundary}`)) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd < 0) continue;
        const headers = part.slice(0, headerEnd);
        const body = part.slice(headerEnd + 4).replace(/\r\n$/, '');
        const nameMatch = /name="([^"]+)"/.exec(headers);
        if (!nameMatch) continue;
        const filenameMatch = /filename="([^"]*)"/.exec(headers);
        if (filenameMatch) {
          fileName = filenameMatch[1];
          fileSize = Buffer.byteLength(body);
        } else {
          fields[nameMatch[1]] = body.trim();
        }
      }
    }
    const id = store.nextId(SVC, 'file');
    store.create(
      SVC,
      'file',
      {
        name: fileName ?? 'file',
        size: fileSize,
        person_id: fields.person_id != null ? Number(fields.person_id) : null,
        organization_id: fields.organization_id != null ? Number(fields.organization_id) : null,
        opportunity_id: fields.opportunity_id != null ? Number(fields.opportunity_id) : null,
        uploader_id: 1,
        created_at: new Date().toISOString(),
      },
      id,
    );
    res.json({ success: true });
  });

  // Opportunities — the paginated search envelope ({opportunities,
  // next_page_token}), a fetch-by-id, and nothing else (the adapter is
  // read-only on opportunities).
  r.get('/opportunities', (req, res) => {
    const term = (req.query.term as string)?.toLowerCase();
    let opportunities = store.list(SVC, 'opportunity');
    if (term) {
      opportunities = opportunities.filter((o) =>
        (o.data.name as string)?.toLowerCase().includes(term),
      );
    }
    res.json({
      opportunities: opportunities.map((o) => ({ id: Number(o.id), ...o.data })),
      next_page_token: null,
    });
  });

  r.get('/opportunities/:id', (req, res) => {
    const opp = store.get(SVC, 'opportunity', req.params.id);
    if (!opp) return res.status(404).json({ error: 'Not found' });
    res.json({ id: Number(opp.id), ...opp.data });
  });

  // Reminders — workspace-wide with optional person/organization/opportunity
  // scoping ({reminders, next_page_token}).
  r.get('/reminders', (req, res) => {
    const orgId = req.query.organization_id as string | undefined;
    const personId = req.query.person_id as string | undefined;
    const opportunityId = req.query.opportunity_id as string | undefined;
    const reminders = store.search(SVC, 'reminder', (d) => {
      if (orgId) return Number((d.organization as { id?: number } | null)?.id) === Number(orgId);
      if (personId) return Number((d.person as { id?: number } | null)?.id) === Number(personId);
      if (opportunityId) {
        return Number((d.opportunity as { id?: number } | null)?.id) === Number(opportunityId);
      }
      return true;
    });
    res.json({
      reminders: reminders.map((rem) => ({ id: Number(rem.id), ...rem.data })),
      next_page_token: null,
    });
  });

  // Relationship strengths — external_id required, internal_id optional;
  // returns a BARE array (the one Affinity read that isn't enveloped).
  r.get('/relationships-strengths', (req, res) => {
    const externalId = req.query.external_id as string | undefined;
    if (!externalId) return res.status(400).json({ error: 'external_id is required' });
    const internalId = req.query.internal_id as string | undefined;
    const rows = store.search(SVC, 'relationship_strength', (d) => {
      if (Number(d.external_id) !== Number(externalId)) return false;
      if (internalId && Number(d.internal_id) !== Number(internalId)) return false;
      return true;
    });
    res.json(rows.map((row) => row.data));
  });

  // Interactions — type + start_time + end_time required, exactly one entity
  // scope; the response keys its array by the interaction kind (`emails` for
  // type 3 is the documented shape).
  r.get('/interactions', (req, res) => {
    const type = req.query.type as string | undefined;
    if (type == null || !(type in INTERACTION_ENVELOPE_KEY)) {
      return res.status(400).json({ error: 'type is required' });
    }
    if (!req.query.start_time || !req.query.end_time) {
      return res.status(400).json({ error: 'start_time and end_time are required' });
    }
    const orgId = req.query.organization_id as string | undefined;
    const personId = req.query.person_id as string | undefined;
    const opportunityId = req.query.opportunity_id as string | undefined;
    if (!orgId && !personId && !opportunityId) {
      return res.status(400).json({ error: 'one of person_id, organization_id, opportunity_id is required' });
    }
    const rows = store.search(SVC, 'interaction', (d) => {
      if (Number(d.type) !== Number(type)) return false;
      if (orgId) return ((d.organization_ids as number[]) ?? []).includes(Number(orgId));
      if (personId) return ((d.person_ids as number[]) ?? []).includes(Number(personId));
      if (opportunityId) return ((d.opportunity_ids as number[]) ?? []).includes(Number(opportunityId));
      return false;
    });
    res.json({
      [INTERACTION_ENVELOPE_KEY[type]]: rows.map((row) => {
        // The scope arrays are the fake's own filter index, not API fields.
        const { organization_ids, person_ids, opportunity_ids, ...data } = row.data as Record<string, unknown>;
        return { id: Number(row.id), ...data };
      }),
      next_page_token: null,
    });
  });

  // Webhook subscriptions — POST /webhooks {webhook_url, subscriptions[]},
  // PUT /webhooks/:id, DELETE /webhooks/:id (Affinity caps these at 3 per
  // instance; the fake doesn't enforce the cap).
  r.post('/webhooks', (req, res) => {
    const id = store.nextId(SVC, 'webhook');
    const data = {
      id: Number(id),
      webhook_url: req.body?.webhook_url ?? '',
      subscriptions: req.body?.subscriptions ?? [],
    };
    store.create(SVC, 'webhook', data, id);
    res.json(data);
  });

  r.put('/webhooks/:id', (req, res) => {
    const existing = store.get(SVC, 'webhook', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...(existing.data as object), subscriptions: req.body?.subscriptions ?? [] };
    store.create(SVC, 'webhook', data, req.params.id);
    res.json(data);
  });

  r.delete('/webhooks/:id', (req, res) => {
    store.delete(SVC, 'webhook', req.params.id);
    res.json({ success: true });
  });

  r.get('/webhooks', (_req, res) => {
    res.json(store.list(SVC, 'webhook').map((w) => w.data));
  });

  return r;
}
