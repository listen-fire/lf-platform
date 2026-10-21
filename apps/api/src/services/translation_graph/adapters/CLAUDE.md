# Designing an adapter's type graph

These rules (2026-07-17), issued reviewing the interactive type-graph explorer
(the `/graph-explorer` page). Apply them to every adapter surface; the explorer
is the acceptance test. See also listen-fire's `packages/movement-lang/CLAUDE.md` (the two questions)
and `plans/2026-07-10-adapter-entry-positions/` layers 6–9 (the model).

1. **1:1 nodes with no fields are a smell.** If an event node carries no facts of
   its own, the `fires` edge should go STRAIGHT to the thing (e.g. `Email
   Received` → just fire into `Email`). An event node earns its existence by
   carrying event-level facts (`action`, `base`, `table`); pure indirection dies.
2. **Nodes aren't readable/writable — edges are.** An entry's r/w are its META
   EDGE's promises (fine); any remaining node-level r/w declaration or rendering
   goes.
3. **Interrogate every one-way edge.** Readable-only or writable-only is often
   MISSING CAPABILITY, not impossibility. Check the API; aim for completeness.
   (WhatsApp `Replies [create]`, `Attachments [no-write]`, etc. — each needs its
   API check, not an assumption.)
4. **Hunt duplicates** (Dropbox `Document` vs `Upload` — probably one concept).
5. **Edges never contain the system name.** `Dropbox Document` → `Document`;
   `Attio File` → `File`; `Slack Message` → `Message`. The instance already says
   which system you're in.
6. **Combine read+write edges that are one relationship** (dropbox `:Files` +
   `:Dropbox Upload` → one `Files` edge, readable and creatable).
7. **Navigate through parents, not deep objects by id at the root.** Present the
   most natural surface (valuations: events through the legal entity). If direct
   access is ever needed, a separate "direct" meta node off the root is the
   escape hatch — do not pollute the main graph pre-emptively.
8. **Avoid instance edges mostly — case by case, by how much type structure the
   system pretends to have.** Sheets: a WHERE filter on `:Spreadsheet`, no named
   per-sheet edges. Airtable: same, `:Base` only. Attio's objects: real type
   structure → separate named edges is right.
9. **An event edge and a regular edge may land on the same node** (Granola:
   readable `Meetings` collection AND `fires` to `Meeting Note`). Both promises,
   two edges, one node — that is the model working, not a conflict.
10. **Declare `sequenced` and `watchable` only from evidence, never from what
    the domain sounds like.** Both are per-edge promises the author's movement
    is then allowed to depend on, and both default to the safe answer when you
    say nothing.
    - `sequenced: 'chronological' | 'document' | 'arrival'` says walking the
      edge hands its members back in an INHERENT order — so a fold that needs
      one (`JOIN`, `FIRST`, `LAST`, `LIMIT`) is allowed without an `ORDER BY`.
      Declare it only where the fetch path actually returns that order today: an
      explicit sort in our code, a SQL `ORDER BY`, or a provider call documented
      to return ordered results (Slack messages, an email's attachments in
      document order, a callback's calls in arrival order). Under-declaring
      costs an author one `ORDER BY`; over-declaring silently blesses a fold
      over an arbitrary sequence. It is a different fact from
      `capability.order`, which is about PUSHDOWN — an edge can be sequenced
      without being order-pushable and the reverse — so never set one because
      the other is true, and leave it absent on a single-valued reference.
    - `watchable: true` says the platform DELIVERS an event when the edge
      resolves, so a run parked on it is woken rather than looked at on a timer.
      Only three edges can say it today (Slack `Replies`, an ask's `Response`, a
      callback's `Called`), and it is what lets an author write
      `await FIRST(…)`; absent, that form is refused and the author owns a
      cadence instead (`await until(…, every: …)`). Absent cannot mean "maybe" —
      a park with nobody to wake it is a run that never finishes. It is a
      sibling of `awaitable`, not a consequence of it: whether an edge resolves
      and whether anyone is told are two facts, and an adapter usually gains the
      second long after the first.
    - `writable: true` is the same kind of promise and the same kind of
      default. Absent means READ-ONLY — the checker refuses a write along the
      edge, and `describe` tells the authoring agent so. An edge your write
      path really does serve must SAY `writable: true`; leaving it off is not a
      weaker claim, it is the absence of one.

**Rule 0, over all of these (ruling 2026-07-17): conform to the most NATURAL
graph — not to the shape of the underlying API.** The API's affordances are
evidence, never the design. Attio's `GET /v2/lists` enumerates workspace-wide
and `parent_object` is an array — but creating a list takes ONE required parent
object, so lists are single-parent in practice and belong under their parent
object. And never let the surface lie about what we can access: no root entry
for a thing that is only really reachable (readable OR writable) through its
parent — access lives where access is real.

Standing method: API-first (read the real docs before changing a surface);
verify every read by RUNNING it against fake-channels; entry-surface changes
silently break WRITES via `memoizedResolver` (run the adapter's tests); walk
your adapter in `/graph-explorer` and read every hop before calling it done;
run `pnpm dev:promiseless --depth 1` — an edge that is neither readable nor
writable nor `fires` nor carries members is one a movement can do nothing with,
and the root should not publish it (position-only types are reached through
their parent).
