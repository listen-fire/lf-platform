//! The names family on its own programs. Parity with the TypeScript checker
//! is the harness's job (parity/run.sh); these pin the walk's scoping.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn codes(source: &str, version: u32) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect()
}

#[test]
fn an_unsupported_version_is_refused_first() {
    let found = codes("x = 1", 99);
    assert_eq!(found[0].0, "MOV_LANGUAGE_VERSION_UNSUPPORTED");
}
