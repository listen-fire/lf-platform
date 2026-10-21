//! The calls, closures and flow families on their own programs. Parity with
//! the TypeScript checker is the harness's job (parity/run.sh); these pin
//! the rules the families add to the walk.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn codes(source: &str, version: u32) -> Vec<(String, String)> {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{}}"#).unwrap();
    let options = CheckOptions { language_version: version, upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect()
}

/// A chain of closures, each returning the last on two branches: the
/// returns' union is one arm per distinct handle (the same handle passed on
/// is itself), so the check is linear in the chain — before, a union that
/// doubled per level made it exponential, and 20 links never finished.
#[test]
fn a_chain_of_closures_returning_the_last_twice_checks_in_linear_time() {
    let catalog = CatalogSnapshot::load(
        r#"{"adapters":{"attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{"company":{"fields":{"name":"text"},"resultShape":{"externalId":"text","name":"text"}}}}}}},"credentials":{"crm_cred":{"adapters":["attio"]}},"plugins":{}}"#,
    )
    .unwrap();
    let links = 60;
    let mut source = String::from("import { attio } from adapters\nimport { crm_cred } from credentials\ncrm = connect attio using crm_cred\nfunction m() {\n  org = write crm-[:companies]-> { name: \"Acme\" }\n  f0 = () => coalesce(org, \"x\")\n");
    for i in 1..=links {
        source += &format!("  f{i} = () => {{\n    if (1 > 0) {{\n      return f{p}()\n    }}\n    return f{p}()\n  }}\n", p = i - 1);
    }
    source += &format!("  g = graph {{ n: f{links}() }}\n}}\n");
    let started = std::time::Instant::now();
    let options = CheckOptions { language_version: 5, upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let found: Vec<String> = check_source(&source, &catalog, options).unwrap().into_iter().map(|d| d.code).collect();
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
    assert_eq!(found, ["MOV_GRAPH_ENTRY_RECORD"]);
}

#[test]
fn a_closure_is_not_held_as_data_under_version_5() {
    let not_data = |line: &str| {
        let source = format!("function m(c: <boolean>) {{\n  label = (x: <number>) => \"x\"\n  {line}\n}}");
        codes(&source, 5).into_iter().filter(|(c, _)| c == "MOV_CLOSURE_NOT_DATA").map(|(_, m)| m).collect::<Vec<_>>()
    };
    assert_eq!(not_data("fs = [label]").len(), 1);
    assert!(not_data("box = { g: label }")[0].starts_with("'g' holds a closure"));
    // Refused once, as the choice's operand, not again as the list's element.
    let chosen = not_data("fs = [(c ? label : 1)]");
    assert_eq!(chosen.len(), 1, "{chosen:?}");
    assert!(chosen[0].starts_with("a value chosen by '… ? … : …'"));
    assert!(not_data("d = map([1, 2], (x) => { return label })")[0].starts_with("'map' answers a list"));
}

/// A function's call handed to a plugin is a value bound (`boundCallShape`):
/// one that returns nothing has none to hand. The plugin declares no
/// `priced`, which reads as unpriced.
#[test]
fn a_call_handed_to_a_plugin_that_returns_nothing_is_refused() {
    let catalog = CatalogSnapshot::load(r#"{"adapters":{},"credentials":{},"plugins":{"relay":{"args":["data"],"output":{"kind":"value","type":"text"}}}}"#).unwrap();
    let source = "import { relay } from plugins\nfunction none(n: <text>) {\n  x = 1\n}\nfunction m(s: <text>) {\n  r = relay({ data: none(n: \"x\") })\n}";
    let options = CheckOptions { language_version: 5, upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let found: Vec<(String, String)> = check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code, d.message)).collect();
    assert!(found.iter().any(|(c, m)| c == "MOV_CALL_RETURNS_NOTHING" && m.starts_with("'none' returns nothing")), "{found:?}");
}
