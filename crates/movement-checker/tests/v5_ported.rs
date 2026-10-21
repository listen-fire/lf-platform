//! Tests written at versions 1 to 4 whose rule does not depend on the
//! version, restated in version 5's surface: scoping, calls, nodes and
//! shaped graphs, walks, listens and their time zones, library imports, a
//! write's absent field, and a retired read of a resource.

use movement_checker::families::values::{WriteFieldAbsence, write_field_absence};
use movement_checker::types::field::{Ty, maybe_absent};
use movement_checker::{CheckOptions, check_source};
use movement_parser::ast::{ExprSlot, FieldEntry, Loc, Span};
use movement_parser::catalog::types::CatalogSnapshot;

const EMPTY: &str = r#"{"adapters":{},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#;

fn run(source: &str, catalog: &str) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(catalog).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect()
}



fn codes(found: &[(String, String)]) -> Vec<&str> {
    found.iter().map(|(c, _)| c.as_str()).collect()
}

fn message<'a>(found: &'a [(String, String)], code: &str) -> &'a str {
    found.iter().find(|(c, _)| c == code).unwrap_or_else(|| panic!("no {code} in {found:?}")).1.as_str()
}

// Calls

#[test]
fn binding_a_call_of_a_movement_that_returns_nothing_is_refused() {
    let source = "function lists(e: <number>) {\n  names = [1]\n}\nfunction main(e: <number>) {\n  x = lists(e)\n}";
    assert_eq!(codes(&run(source, EMPTY)), ["MOV_CALL_RETURNS_NOTHING"]);
}

#[test]
fn a_callback_that_reaches_a_wait_through_a_movement_is_refused() {
    let source = "function waits(n: <number>) {\n  await sleep(1h)\n  return n\n}\nfunction main(e: <number>) {\n  cb = callback(waits)\n}";
    assert_eq!(codes(&run(source, EMPTY)), ["MOV_WAIT_NOT_RESUMABLE"]);
}

#[test]
fn movements_calling_each_other_declare_what_they_return() {
    let source = "function ping(n: <number>) {\n  if (n == 0) {\n    return 0\n  }\n  return pong(n - 1)\n}\nfunction pong(n: <number>): <number> {\n  return ping(n)\n}";
    let found = run(source, EMPTY);
    assert_eq!(codes(&found), ["MOV_RECURSIVE_RETURN_TYPE"]);
    assert!(found[0].1.contains("(ping → pong → ping)"), "{found:?}");
}

#[test]
fn a_closure_that_calls_itself_and_returns_nothing_binds_nothing() {
    let source = "function main(e: <number>) {\n  tick = (n: <number>) => {\n    if (n > 0) {\n      y = tick(n - 1)\n    }\n  }\n  tick(2)\n}";
    assert_eq!(codes(&run(source, EMPTY)), ["MOV_CALL_RETURNS_NOTHING"]);
}

#[test]
fn a_value_argument_is_held_to_its_parameter_type() {
    let source = "function inc(v: <number>): <number> {\n  return v + 1\n}\nfunction main(e: <number>) {\n  x = inc(\"three\")\n  y = inc(e)\n}";
    let found = run(source, EMPTY);
    assert_eq!(found, [("MOV_CALL_ARG_TYPE".to_string(), "'inc' expects number for 'v' (argument 1), but this argument is text".to_string())]);
}

#[test]
fn a_record_literal_argument_carries_only_the_keys_its_parameter_declares() {
    let source = "function configured(cfg: <{ mode: text, owner?: text }>) {\n  x = 1\n}\nfunction main(e: <number>) {\n  configured({ mode: \"fast\", ownr: \"sam\" })\n}";
    let found = run(source, EMPTY);
    assert_eq!(codes(&found), ["MOV_CALL_ARG_TYPE"]);
    assert!(found[0].1.ends_with("which has no key 'ownr' — did you mean 'owner'?"), "{found:?}");
}

#[test]
fn a_builtin_argument_of_the_wrong_kind_is_refused() {
    let found = run("function main(e: <number>) {\n  x = Text.upper(e)\n}", EMPTY);
    assert_eq!(found, [("MOV_BUILTIN_ARG_TYPE".to_string(), "Text.upper's 'text' takes text, and this is number — Text.upper(text)".to_string())]);
}

#[test]
fn a_collection_op_reads_its_settings_as_written() {
    let source = "function main(e: <number>) {\n  names = [\"a\", \"b\"]\n  x = map(names, (t) => { return t }, { concurrency: 2, initialConcurrency: 4 })\n}";
    let message = "'map' runs its first batch 4 at a time and the rest 2 at a time — the first batch is the warm-up, so it is never the wider one. Lower initialConcurrency, or raise concurrency.";
    assert_eq!(run(source, EMPTY), [("MOV_COLLECTION_OP_CONFIG".to_string(), message.to_string())]);
}

#[test]
fn a_collection_ops_function_takes_its_members_type() {
    let source = "function main(e: <number>) {\n  xs = [1, 2]\n  x = map(xs, (t) => { return Text.upper(t) })\n  y = map(e, (t) => { return t })\n}";
    let found = run(source, EMPTY);
    assert!(message(&found, "MOV_BUILTIN_ARG_TYPE").starts_with("Text.upper's 'text' takes text, and this is number"), "{found:?}");
    assert!(message(&found, "MOV_COLLECTION_OP_NOT_A_COLLECTION").starts_with("'map' reads a collection, and this is number"), "{found:?}");
}

// Names

#[test]
fn a_read_before_its_binding_is_use_before_bind_and_an_unknown_name_is_unresolved() {
    let found = run("function m(n: <number>) {\n  a = later + 1\n  later = 2\n  b = nowhere\n}", EMPTY);
    assert_eq!(codes(&found), ["MOV_USE_BEFORE_BIND", "MOV_NAME_UNRESOLVED"]);
}

#[test]
fn a_block_s_bindings_do_not_escape_it() {
    let source = format!("{REG_PRELUDE}function m(n: <number>) {{\n  out = reg-[x:entities]-> {{\n    inner = 1\n    return inner\n  }}\n  y = inner\n}}\n");
    let found: Vec<_> = run(&source, REG).into_iter().filter(|(c, _)| c != "MOV_LISTEN_MISSING").collect();
    assert_eq!(codes(&found), ["MOV_NAME_UNRESOLVED"]);
    assert!(found[0].1.contains("bound inside a traversal block") && found[0].1.contains("'out = …"), "{found:?}");
}

#[test]
fn a_credential_is_never_a_value() {
    let found = run("import { crm_cred } from credentials\nfunction m(n: <number>) {\n  x = crm_cred\n}", EMPTY);
    assert_eq!(codes(&found), ["MOV_CREDENTIAL_NOT_A_VALUE"]);
}

#[test]
fn function_names_differing_only_in_case_collide() {
    let found = run("function Notify(n: <number>) {\n}\nfunction notify(n: <number>) {\n}", EMPTY);
    assert_eq!(codes(&found), ["MOV_FUNCTION_NAME_COLLISION"]);
}

#[test]
fn an_inner_name_may_not_hide_an_outer_one() {
    let found = run("x = 1\nfunction m(x: <number>) {\n}", EMPTY);
    assert_eq!(codes(&found), ["MOV_SHADOWED_NAME"]);
    assert!(found[0].1.contains("a binding at line 1"), "{found:?}");
}

// Nodes and shaped graphs

#[test]
fn a_shaped_graph_built_from_a_spread_walks_its_declared_children() {
    let source = "node Note {\n  text: <text>\n  node tag {\n    label: <text>\n  }\n}\nfunction main() {\n  v = { text: \"hello\", tag: [{ label: \"a\" }] }\n  g = graph<Note> { ...v }\n  g-[t:tag]-> {\n    l = t.label\n  }\n}\n";
    assert_eq!(run(source, EMPTY), vec![]);
}

#[test]
fn a_node_literal_argument_is_judged_by_structure() {
    let source = "node Doc {\n  title: <text>\n}\nfunction takes(d: <Doc>) {\n}\nfunction main() {\n  takes(node { nope: \"x\" })\n}\n";
    assert_eq!(run(source, EMPTY), [("MOV_NODE_ARG_SHAPE".to_string(), "'takes' expects Doc.Doc for 'd' (argument 1), and it has no `title`".to_string())]);
}

#[test]
fn an_extends_cycle_names_the_chain() {
    let found = run("node A extends B {\n  a: <text>\n}\nnode B extends A {\n  b: <text>\n}\n", EMPTY);
    assert_eq!(codes(&found), ["MOV_EXTENDS_CYCLE", "MOV_EXTENDS_CYCLE"]);
    assert!(found[0].1.contains("(A extends B extends A)") && found[1].1.contains("(B extends A extends B)"), "{found:?}");
}

#[test]
fn a_shaped_graph_needs_every_required_field() {
    let source = "node Note {\n  text: <text>\n  tag: <text | null>\n}\nfunction main() {\n  g = graph<Note> { }\n}\n";
    assert_eq!(
        run(source, EMPTY),
        [("MOV_GRAPH_FIELD_MISSING".to_string(), "<Note> needs `text` (text) and this graph doesn't write it — only a field declared '<T | null>' may be left out".to_string())]
    );
}

#[test]
fn a_built_graph_is_not_a_record_to_update() {
    let source = "node Company {\n  thesis: <text | null>\n}\nfunction main() {\n  g = graph<Company> { thesis: \"a\" }\n  write g { thesis: \"x\" }\n}\n";
    assert_eq!(
        run(source, EMPTY),
        [(
            "MOV_WRITE_POSITION_NOT_RECORD".to_string(),
            "'g' is a <Company> graph — 'write g { … }' updates an already-identified record in place, so it needs a record position: a traversal alias or a prior write result".to_string()
        )]
    );
}

// Walks

const REG: &str = r#"{"adapters":{"registry":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"public_registry":{"positions":{"entity":{"properties":{"Name":"text","City":"text"},"edges":{"Holdings":{"target":"holding"}}},"holding":{"properties":{"Amount":"number"},"edges":{}}},"collections":{"entities":{"target":"entity"}},"writableRoots":{}}}}},"credentials":{"public_registry":{"adapters":["registry"]}},"plugins":{}}"#;
const REG_PRELUDE: &str = "import { registry } from adapters\nimport { public_registry as pr } from credentials\nreg = connect registry using pr\n";

fn walk(body: &str) -> Vec<(String, String)> {
    let source = format!("{REG_PRELUDE}function main(e: <reg-[:entity]->>) {{\n{body}\n}}\n");
    run(&source, REG).into_iter().filter(|(c, _)| c != "MOV_LISTEN_MISSING").collect()
}

#[test]
fn an_unknown_edge_names_the_edges_there_are() {
    assert_eq!(walk("  e-[h:Holding]-> { x = h.Amount }"), [("MOV_TRAVERSE_UNKNOWN_EDGE".to_string(), "reg.entity has no edge 'Holding' — it has: Holdings".to_string())]);
}

#[test]
fn a_hop_alias_reads_the_position_it_landed_on() {
    assert_eq!(
        walk("  e-[h:Holdings]-> { x = h.Amont }"),
        [("MOV_UNKNOWN_PROPERTY".to_string(), "reg.holding has no field 'Amont' — it has: Amount — did you mean 'Amount'?".to_string())]
    );
}

#[test]
fn a_parameter_type_names_a_position_the_schema_has() {
    let source = format!("{REG_PRELUDE}function main(e: <reg-[:Entity]->>) {{\n}}\n");
    let found = run(&source, REG);
    assert!(found.contains(&("MOV_UNKNOWN_POSITION".to_string(), "'reg' has no position type 'Entity' — it has: entity, holding".to_string())), "{found:?}");
}

#[test]
fn an_unknown_meta_key_suggests_the_closest() {
    assert_eq!(walk("  x = @user_emial"), [("MOV_META_UNKNOWN_KEY".to_string(), "'@user_emial' isn't a known meta field. Did you mean '@user_email'?".to_string())]);
}

// Listens

const CRON: &str = r#""cron":{"constructionArgs":[],"canFire":true,"triggerConfig":["schedule","timezone"],"triggerConfigRequired":["schedule"],"triggerConfigFormats":{"schedule":"cron","timezone":"timezone"},"schemas":{"":{"positions":{"Tick":{"properties":{},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Tick","eventPositions":[{"position":"Tick"}]}}}"#;

fn cron_catalog() -> String {
    format!(r#"{{"adapters":{{{CRON}}},"credentials":{{}},"plugins":{{}}}}"#)
}

#[test]
fn a_dispatchable_movement_without_a_listen_is_told_how_to_add_one() {
    let found = run("import { cron } from adapters\nt = connect cron\nfunction digest(e: <t-[:Tick]->>) {}", &cron_catalog());
    assert_eq!(codes(&found), ["MOV_LISTEN_MISSING"]);
    assert!(found[0].1.ends_with("e.g. listen to t { schedule: \"0 9 * * 1\" } fire digest"), "{found:?}");
}

#[test]
fn any_listen_silences_the_missing_listen_and_its_config_is_checked() {
    let source = "import { cron } from adapters\nt = connect cron\nfunction digest(e: <t-[:Tick]->>) {}\nlisten to t { schedule: \"61 9 * * 1\" } fire digest";
    let found = run(source, &cron_catalog());
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(found[0].1.contains("minute value 61 is out of range (0-59)"), "{found:?}");
}

/// A host whose zone database holds one zone.
struct OneZone(&'static str);

impl movement_checker::host::ZoneLookup for OneZone {
    fn is_zone(&self, zone: &str) -> bool {
        zone == self.0
    }
}

#[test]
fn a_cron_time_zone_is_the_hosts_to_recognise() {
    let source = "import { cron } from adapters\nt = connect cron\nfunction digest(e: <t-[:Tick]->>) {}\nlisten to t { schedule: \"0 9 * * 1\", timezone: \"Narnia/Cair\" } fire digest";
    let catalog = CatalogSnapshot::load(&cron_catalog()).unwrap();
    let with = |zones: &dyn movement_checker::host::ZoneLookup| check_source(source, &catalog, CheckOptions { language_version: 5, upgrading_from: None, zones }).unwrap();
    let refused = with(&movement_checker::host::native::NativeZones);
    assert_eq!(refused.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(refused[0].message.starts_with("'Narnia/Cair' is not a recognised IANA time zone"), "{}", refused[0].message);
    assert!(with(&OneZone("Narnia/Cair")).is_empty());
}

// Libraries

#[test]
fn a_library_is_checked_once_and_its_errors_surface_at_the_import() {
    let catalog = r#"{"adapters":{},"credentials":{},"plugins":{},"files":{"lib/a":{"source":"export function helper(n: <number>) {\n  x = nowhere\n}"}}}"#;
    let source = "import { helper } from \"lib/a\"\nimport { nope } from \"lib/a\"\nfunction m(n: <number>) {\n  helper(n)\n}";
    let catalog = CatalogSnapshot::load(catalog).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let found = check_source(source, &catalog, options).unwrap();
    assert_eq!(found.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_IMPORT_NOT_EXPORTED", "MOV_NAME_UNRESOLVED"]);
    assert!(found[0].message.starts_with("\"lib/a\" does not export 'nope'"), "{}", found[0].message);
    assert!(found[1].message.starts_with("\"lib/a\" line 2: Unknown name 'nowhere'"), "{}", found[1].message);
    assert_eq!(found[1].span.start.line, 1);
}

// Extraction

#[test]
fn a_retired_resource_read_is_refused_inside_a_head_with_the_bare_field_and_outside_it_with_a_walk() {
    let source = "import { registry } from adapters\nimport { public_registry as pr } from credentials\nreg = connect registry using pr\nnode Company: \"each company\" {\n  name: <text> \"its name\"\n}\nfunction main(e: <reg-[:entity]->>) {\n  found = extractOne([e.`Name`], Company)\n  found-[r:_resources WHERE @resource.url != \"\"]-> { u = r.url }\n  x = @resource.url\n}\n";
    let catalog = CatalogSnapshot::load(EXTRACT_CATALOG).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let found: Vec<_> = check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.code != "MOV_LISTEN_MISSING").collect();
    assert_eq!(found.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_RESOURCE_READ_RETIRED", "MOV_RESOURCE_READ_RETIRED"]);
    assert_eq!(found[0].message, "'@resource.url' is retired — inside a -[:_resources WHERE …]-> filter, write the field's bare name: 'url'");
    assert_eq!(found[0].fix.as_ref().unwrap()["edits"][0]["text"], "url");
    assert!(found[1].message.contains("outside a -[:_resources WHERE …]-> filter it was always null"), "{}", found[1].message);
}

// A write's field that may be absent

fn span() -> Span {
    Span { start: Loc { line: 9, col: 35 }, end: Loc { line: 9, col: 36 } }
}

fn field(raw: &str) -> FieldEntry {
    FieldEntry { name: "Title".into(), value: ExprSlot::plain(raw.into(), span()), semantics: None, span: span() }
}

fn absence<'a>(field: &'a FieldEntry, value: &'a Ty, target: Option<&'a Ty>, identifies: bool) -> WriteFieldAbsence<'a> {
    WriteFieldAbsence { field, spread: None, target_type: target, value_type: Some(value), root_description: "board.Lane", may_leave_unset: true, identifies, version: 5 }
}

#[test]
fn a_maybe_absent_value_in_a_plain_field_falls_back_or_stays_unset() {
    let entry = field("n");
    let value = maybe_absent(Ty::Text);
    let found = write_field_absence(absence(&entry, &value, Some(&Ty::Text), false)).unwrap();
    assert_eq!(found.code, "MOV_ABSENT_REQUIRED");
    assert_eq!(
        found.message,
        "'Title' on board.Lane needs a value, but 'n' may be absent (text (or absent)) — write 'Title: coalesce(n, \"unknown\")' to fall back to a value that is always there, or 'Title ?: n' to leave it unset when absent"
    );
    assert_eq!(found.fix.unwrap()["edits"][0]["text"], "coalesce(n, \"unknown\")");
}

#[test]
fn an_identifying_field_is_gated_not_given_a_fallback() {
    let entry = field("n");
    let value = maybe_absent(Ty::Text);
    let found = write_field_absence(absence(&entry, &value, Some(&Ty::Text), true)).unwrap();
    assert!(found.message.ends_with("and it identifies the record, so a fallback would merge every record written without it into one — write only when it is there: put the write inside 'if (n != null) { … }'"), "{}", found.message);
    assert!(found.fix.is_none());
}

const EXTRACT_CATALOG: &str = r#"{"adapters":{"registry":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"public_registry":{"positions":{"entity":{"properties":{"Name":"text","City":"text","Stage":{"kind":"enum","options":["Seed","Growth"]}},"edges":{"Holdings":{"target":"holding"}}},"holding":{"properties":{"Amount":"number"},"edges":{}}},"collections":{"entities":{"target":"entity"}},"writableRoots":{"entities":{"fields":{"Name":"text","Founded":"date","Stage":{"kind":"enum","options":["Seed","Growth"]}},"resultShape":{"Name":"text"}}}}}}},"credentials":{"public_registry":{"adapters":["registry"]}},"plugins":{"lookup":{"args":["q"],"priced":false,"requiredArgs":["q"]}},"models":["claude-opus-5"]}"#;
