//! Language version 5's surface through the Rust checker: the everyday
//! spelling checks, an old spelling is MOV_V5_SPELLING with its rewrite, and
//! messages name built-ins in the program's own spelling. Parity with the TypeScript checker is
//! parity/run.sh's.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn check(source: &str, version: u32) -> Vec<movement_checker::Diagnostic> {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn codes(source: &str, version: u32) -> Vec<String> {
    check(source, version).into_iter().map(|d| d.code).collect()
}

const V5: &str = "function go(t: <text>, n: <number>) {\n  a = Text.upper(Text.trim(t))\n  b = n > 1 && n < 5 ? Number.round(n) : 0\n  if (a != null || !(n == 2)) {\n    c = Text.length(a)\n  }\n}";
const OLD: &str = "movement go(t: <text>, n: <number>) {\n  a = UPPER(TRIM(t))\n  b = IF n > 1 AND n < 5 THEN ROUND(n) ELSE 0 END\n  if a != NULL OR NOT (n == 2) {\n    c = LENGTH(a)\n  }\n}";

#[test]
fn the_everyday_spelling_checks() {
    assert_eq!(codes(V5, 5), ["MOV_PRESENCE_TEST_CONSTANT"]);
}

#[test]
fn an_old_spelling_under_5_is_refused_with_its_rewrite() {
    let found = check(OLD, 5);
    let spelling: Vec<_> = found.iter().filter(|d| d.code == "MOV_V5_SPELLING").collect();
    assert!(spelling.len() >= 8, "{spelling:#?}");
    assert!(spelling.iter().all(|d| d.fix.is_some()));
    let upper = spelling.iter().find(|d| d.message.starts_with("`UPPER`")).unwrap();
    assert_eq!(upper.message, "`UPPER` is written `Text.upper` from language version 5");
    assert_eq!(upper.fix.as_ref().unwrap()["edits"][0]["text"], "Text.upper");
}

#[test]
fn a_message_names_a_built_in_in_the_program_s_spelling() {
    let v5: Vec<String> = check("function go(n: <number>) {\n  a = Text.upper(n)\n}", 5).into_iter().map(|d| d.message).collect();
    assert_eq!(v5, ["Text.upper's 'text' takes text, and this is number — Text.upper(text)"]);
}

#[test]
fn a_message_suggests_the_surface_of_its_program_s_version() {
    let v5: Vec<String> = check("function go() {\n  f = () => 1\n  x = !f\n  y = f && f\n}", 5).into_iter().map(|d| d.message).collect();
    assert!(v5[0].starts_with("a value negated by '!' is a closure"), "{v5:?}");
    assert!(v5[1].starts_with("a value joined by '&&' is a closure"), "{v5:?}");
}

const PDF_OLD: &str = "movement go(t: <text>) {\n  f = FILE(t, \"pdf\")\n}";
const PDF_V5: &str = "function go(t: <text>) {\n  f = File.from(t, \"pdf\")\n}";

#[test]
fn a_pdf_is_the_pdf_plugin_s_from_version_5() {
    for (source, written) in [(PDF_OLD, "FILE"), (PDF_V5, "File.from")] {
        let found = check(source, 5);
        let pdf: Vec<_> = found.iter().filter(|d| d.code == "MOV_V5_SPELLING" && d.message.contains("@lf/pdf")).collect();
        assert_eq!(pdf.len(), 1, "{written}: {found:#?}");
        assert_eq!(pdf[0].fix.as_ref().unwrap()["edits"][0]["text"], "pdf.render(t)", "{written}");
        // The rewrite also needs an import, which an expression's edit cannot add.
        assert_ne!(pdf[0].fix.as_ref().unwrap()["safe"], true, "{written}");
    }
}

#[test]
fn text_is_a_file_kind() {
    assert!(codes("function go(t: <text>) {\n  f = File.from(t, \"text\")\n}", 5).is_empty());
}

const PDF_CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{"render":{"args":["text"],"priced":false,"argTypes":{"text":"text"},"requiredArgs":["text"],"effects":{},"output":{"kind":"value","type":"file"},"package":"@lf/pdf"}}}"#;

#[test]
fn the_pdf_package_used_with_no_import_offers_its_import_line() {
    let catalog = CatalogSnapshot::load(PDF_CATALOG).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let found = check_source("function go(t: <text>) {\n  f = pdf.render(t)\n}", &catalog, options).unwrap();
    let unresolved: Vec<_> = found.iter().filter(|d| d.code == "MOV_NAME_UNRESOLVED").collect();
    assert_eq!(unresolved.len(), 1, "{found:#?}");
    let edit = &unresolved[0].fix.as_ref().unwrap()["edits"][0];
    assert_eq!(edit["text"], "import { `@lf/pdf` as pdf } from plugins\n");
    assert_eq!(edit["span"]["start"]["line"], 1);
}
