// Version 3's engine corpus tests whose behaviour listen-fire 0.13 retired for
// automations on a legacy language version, each by Henry's ruling (named in
// its reason). An author could see each of these, so none belongs in
// `triage.cjs` (changes no author can observe); and none is a version
// conditional, because the ruling keeps no shim. Read by the same runner as
// the triage list, in the same entry shape.

const CALLBACKS_RETIRED =
  "callbacks retired in listen-fire 0.13 for automations on a legacy language version (rulings 7 and 11): a callback is refused by name, and the save's scan names it; the test parks through one, or asserts it is interpretable";

const EVENT_TYPES_RETIRED =
  "0.12 event types retired in listen-fire 0.13: a catalog no longer types a settings listen's events (no event narrowing keys), and a legacy pin's listens no longer fire (rulings 2 and 11), so nothing seeds a typed event";

const LEGACY_AWAIT_RETIRED =
  "the 0.12 adapter await is retired in listen-fire 0.13 (a wait is on an arrival): the matcher every test in this file calls is gone";

exports.retired = [
  { file: 'services/movement_engine/__test__/node_synthesis.unit.test.ts', test: "the captured scope holds the traversal and its own scope — no landings", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/node_synthesis.unit.test.ts', test: "a synthesised node parks its deferred edge the same way", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/node_synthesis.unit.test.ts', test: "an EAGER edge parks what it already walked", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/node_synthesis.unit.test.ts', test: "the parked edge holds the walk AND the tail literal — no landings", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/node_synthesis.unit.test.ts', test: "a park carries the appended landings — the handle survives it", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/call_value.unit.test.ts', test: "the VALUE carries what the body made, and nothing else", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/call_value.unit.test.ts', test: "the parked value holds the WALK — no landings, nothing walked", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/interpretable.unit.test.ts', test: "a movement minting a callback is not flagged", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/interpretable.unit.test.ts', test: "the named form and the body-less form are equally interpretable", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/interpretable.unit.test.ts', test: "a callback BODY's own unsupported constructs are still named", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/resume_inside.unit.test.ts', test: "awaiting a reply in each member: resuming one member never disturbs the others", reason: CALLBACKS_RETIRED },
  { file: 'services/movement_engine/__test__/typed_event_run.unit.test.ts', wholeFile: true, reason: EVENT_TYPES_RETIRED },
  { file: 'services/movement_engine/__test__/await_landing_where.unit.test.ts', wholeFile: true, reason: LEGACY_AWAIT_RETIRED },
];
