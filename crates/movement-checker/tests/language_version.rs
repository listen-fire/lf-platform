//! A pin this release does not support is refused with its standing
//! diagnostic alone: the program is not walked, so nothing it holds is said.

use movement_checker::{CheckOptions, check_program};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

/// A program with an error of its own, which a walk would report.
const SOURCE: &str = "function m(n: <number>) {\n  a = nowhere\n}\n";

fn options(language_version: u32) -> CheckOptions<'static> {
    CheckOptions { language_version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones }
}

#[test]
fn a_version_4_pin_is_refused_with_the_one_standing_diagnostic() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let program = movement_parser::stmt::parse_program(SOURCE, 5, false).unwrap();
    let found: Vec<(String, String)> = check_program(&program, &catalog, options(4)).into_iter().map(|d| (d.code, d.message)).collect();
    assert_eq!(
        found,
        [(
            "MOV_LANGUAGE_VERSION_UNSUPPORTED".to_string(),
            "this automation is written in language version \"Luminous Owl\" (4), which this release does not support, so it will not validate or run. To fix: validate it under \"Dancing Wren\" (5), repair what that reports, and upgrade it to \"Dancing Wren\" (5).".to_string()
        )]
    );
    let answer = movement_checker::answer::check_answer(&program, &catalog, options(4));
    assert_eq!(answer.diagnostics.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_LANGUAGE_VERSION_UNSUPPORTED"]);
    assert!(answer.stamps.is_empty());
}

#[test]
fn version_5_walks_the_program() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let program = movement_parser::stmt::parse_program(SOURCE, 5, false).unwrap();
    let codes: Vec<String> = check_program(&program, &catalog, options(5)).into_iter().map(|d| d.code).collect();
    assert_eq!(codes, ["MOV_NAME_UNRESOLVED"]);
}
