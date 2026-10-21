//! The nodes family: node declarations, node and graph literals, and a
//! declared node as a parameter's type.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

fn codes_at(source: &str, version: u32) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options)
        .unwrap()
        .into_iter()
        .filter(|d| d.code != "MOV_LISTEN_MISSING" && d.code != "MOV_LANGUAGE_VERSION_DEPRECATED")
        .map(|d| (d.code, d.message))
        .collect()
}

const RUN_BUILT_V5: &str = "node Company {\n  name: <text>\n  thesis: <text | null>\n}\nfunction main() {\n  deduped = node { companies: <Company> order by arrival }\n  write deduped-[:companies]-> { name: \"Acme\" }\n  map(deduped-[:companies]->, (e) => {\n    BODY\n  })\n}\n";

#[test]
fn a_record_this_run_built_updates_in_place_by_its_landing_type() {
    assert_eq!(
        codes_at(&RUN_BUILT_V5.replace("BODY", "write e { nope: \"x\" }"), 5),
        vec![("MOV_WRITE_UNKNOWN_FIELD".into(), "'e' (Company.Company this run built) has no field 'nope' — it has: name, thesis".into())]
    );
}

/// Debugging aid: `NODES_CASE=<dir>` checks `<dir>/case.mov` against `<dir>/case.json`.
#[test]
fn debug_case() {
    let Ok(dir) = std::env::var("NODES_CASE") else { return };
    let source = std::fs::read_to_string(format!("{dir}/case.mov")).unwrap();
    let catalog = CatalogSnapshot::load(&std::fs::read_to_string(format!("{dir}/case.json")).unwrap()).unwrap();
    let version = std::env::var("NODES_VERSION").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    for d in check_source(&source, &catalog, options).unwrap() {
        eprintln!("{} {:?} {}", d.code, d.span, d.message);
    }
}
