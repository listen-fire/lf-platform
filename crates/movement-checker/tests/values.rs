//! The values family's statement rules against the TypeScript's answers,
//! read off the parity corpus (crates/movement-checker/parity) on 2026-10-15.

use movement_checker::families::values::{WriteFieldAbsence, write_field_absence};
use movement_checker::types::field::{Ty, maybe_absent};
use movement_parser::ast::{ExprSlot, FieldEntry, FieldWriteMode, Loc, Span};

fn span() -> Span {
    Span { start: Loc { line: 9, col: 35 }, end: Loc { line: 9, col: 36 } }
}

fn field(raw: &str, semantics: Option<FieldWriteMode>) -> FieldEntry {
    FieldEntry { name: "Title".into(), value: ExprSlot::plain(raw.into(), span()), semantics, span: span() }
}

fn absence<'a>(field: &'a FieldEntry, value: &'a Ty, target: Option<&'a Ty>, identifies: bool) -> WriteFieldAbsence<'a> {
    WriteFieldAbsence { field, spread: None, target_type: target, value_type: Some(value), root_description: "board.Lane", may_leave_unset: true, identifies, version: 5 }
}

#[test]
fn fill_a_nullable_field_and_a_present_value_take_it() {
    let value = maybe_absent(Ty::Text);
    let fill = field("n", Some(FieldWriteMode::Fill));
    assert!(write_field_absence(absence(&fill, &value, Some(&Ty::Text), false)).is_none());
    let plain = field("n", None);
    assert!(write_field_absence(absence(&plain, &value, Some(&maybe_absent(Ty::Text)), false)).is_none());
    assert!(write_field_absence(absence(&plain, &Ty::Text, Some(&Ty::Text), false)).is_none());
}

/// A U+FDD0 in the source: the engine's text form writes it twice, so a
/// source already in that form is checked as it is (`check_form`), and a
/// message quoting it reads once outside (`external_text`).
#[test]
fn a_source_in_the_engines_text_form_is_not_formed_twice() {
    use movement_checker::{CheckOptions, check_form, check_source};
    use movement_parser::catalog::types::CatalogSnapshot;
    use movement_parser::util::form::{external_text, form_of_text};
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = || CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let source = "movement m(nope: <text>) {\n  y = \"\u{FDD0}\" + nope\n}";
    let hint = |diagnostics: Vec<movement_checker::Diagnostic>| {
        diagnostics.into_iter().find(|d| d.code == "MOV_ARITH_NON_NUMERIC").map(|d| external_text(&d.message).into_owned()).unwrap()
    };
    let outside = hint(check_source(source, &catalog, options()).unwrap());
    assert!(outside.ends_with("instead: \"\u{FDD0}${nope}\"."), "{outside}");
    assert_eq!(hint(check_form(&form_of_text(source), &catalog, options()).unwrap()), outside);
}

fn codes_of(source: &str, version: u32) -> Vec<(String, String)> {
    use movement_checker::{CheckOptions, check_source};
    use movement_parser::catalog::types::CatalogSnapshot;
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect()
}

/// `blank = null` binds no type (the slot's bare literal short-circuits),
/// so nothing says a presence test of it is constant.
#[test]
fn a_name_bound_to_null_is_not_always_present() {
    let found = codes_of("movement m(s: <text>) {\n  blank = null\n  t = \"${EXISTS(s)} ${EXISTS(blank)}\"\n}", 5);
    let constant: Vec<_> = found.iter().filter(|(c, _)| c == "MOV_PRESENCE_TEST_CONSTANT").collect();
    assert_eq!(constant.len(), 1, "{found:?}");
    assert!(constant[0].1.starts_with("'s' always has a value"));
}

/// `...held.k` copies the keys of the map the path reads.
#[test]
fn a_graph_spread_through_a_path_carries_the_keys_it_reads() {
    let found = codes_of("movement m(s: <text>) {\n  held = { k: { name: s } }\n  g = graph { ...held.k, stage: \"new\" }\n  x = g.name\n  y = g.nope\n}", 5);
    let unknown: Vec<_> = found.iter().filter(|(c, _)| c == "MOV_UNKNOWN_PROPERTY").collect();
    assert_eq!(unknown.len(), 1, "{found:?}");
    assert!(unknown[0].1.contains("'nope'"), "{found:?}");
}
