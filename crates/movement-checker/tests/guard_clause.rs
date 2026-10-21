//! A branch that always leaves — `if (x == null) { fail("…") }`, a `return`,
//! or an `if` whose every arm and `else` leave — proves its condition false for
//! the rest of the enclosing block, so a record that may be absent is present
//! below it, and every presence check (a write off it, a block's walk, a walk
//! inside an expression, a required write field) accepts it. TypeScript's
//! guard clause, with `fail` in the role of `throw`. Only a branch that
//! always leaves narrows below it: an `if` never prefers one of its arms.
//! `x != null && …` and `x == null || …` narrow `x` on the right side too.
//! The TypeScript twin is
//! packages/legacy-lang/checker/__test__/guard_clause.unit.test.ts, same
//! programs, same answers.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"chat":{"canFire":true,"constructionArgs":[],"schemas":{"":{"positions":{"Channel":{"properties":{"Name":"text","Topic":"text"},"edges":{"Messages":{"target":"Message","writable":true}}},"Message":{"properties":{"Message":"text"},"edges":{}}},"collections":{"Channels":{"target":"Channel"}},"writableRoots":{"Channel":{"fields":{"Name":"text"},"resultShape":{"externalId":"text"}},"Message":{"fields":{"Message":"text"},"resultShape":{"externalId":"text"}}}}}}},"credentials":{},"plugins":{}}"#;

/// The presence refusals `body` draws. `x` is the one channel named
/// "alerts", which may not be there.
fn absent(body: &str) -> Vec<String> {
    let source = format!("import {{ `@lf/chat` as chat }} from adapters\nc = connect chat\n\nfunction go() {{\n  x = only(c-[h:Channels WHERE h.Name == \"alerts\"]->)\n{body}\n}}\n");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { language_version: 5, upgrading_from: None, parse_version: None, zones: &movement_checker::host::native::NativeZones };
    let diagnostics = check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    let errors: Vec<_> = diagnostics.into_iter().filter(|d| d.is_error()).collect();
    let other: Vec<_> = errors.iter().filter(|d| d.code != "MOV_ABSENT_REQUIRED").map(|d| format!("{}: {}", d.code, d.message)).collect();
    assert!(other.is_empty(), "{source}\n{other:?}");
    errors.into_iter().map(|d| d.message).collect()
}

/// Each place a record that may be absent is refused.
const POSITIONS: [(&str, &str); 5] = [
    ("a write off it", "  write x-[:Messages]-> { Message: \"hi\" }"),
    ("a required write field read off it", "  write c-[:Channels]-> { Name: x.`Name` }"),
    ("a block's walk off it", "  x-[m:Messages]-> {\n    write c-[:Channels]-> { Name: m.`Message` }\n  }"),
    ("an aggregate walk", "  n = count(x-[:Messages]->)\n  return n"),
    ("an exists with a hop", "  return exists(x-[:Messages]->)"),
];

/// Branches that always leave, each proving `x` present below them.
const GUARDS: [(&str, &str); 7] = [
    ("fail", "  if (x == null) { fail(\"no channel\") }"),
    ("return", "  if (x == null) { return \"none\" }"),
    ("a disjunction that fails", "  if (x == null || 1 == 2) { fail(\"no channel\") }"),
    ("an arm that fails after another that returns", "  if (1 == 2) { return \"early\" } else if (x == null) { fail(\"no channel\") }"),
    ("an else that fails", "  if (x != null) {\n    y = 1\n  } else {\n    fail(\"no channel\")\n  }"),
    ("a nested if whose every arm leaves", "  if (x == null) {\n    if (1 == 1) { fail(\"a\") } else { return \"b\" }\n  }"),
    ("a guard inside the block it narrows", "  if (1 == 1) {\n    if (x == null) { fail(\"no channel\") }\n  BODY\n  }"),
];

/// Branches that can fall through, so nothing below them is proved.
const NOT_GUARDS: [(&str, &str); 7] = [
    ("an empty arm", "  if (x == null) { }"),
    ("an arm that leaves only sometimes", "  if (x == null) {\n    if (1 == 1) { fail(\"a\") }\n  }"),
    ("a conjunction that fails", "  if (x == null && 1 == 1) { fail(\"no channel\") }"),
    ("an earlier arm that falls through", "  if (1 == 1) {\n    y = 1\n  } else if (x == null) { fail(\"no channel\") }"),
    ("an if with no else", "  if (x != null) {\n    y = 1\n  }"),
    ("a guard inside an arm, used after the if", "  if (1 == 1) {\n    if (x == null) { fail(\"no channel\") }\n  }"),
    ("a guard inside a walk's block, used after it", "  c-[k:Channels]-> {\n    if (x == null) { return \"none\" }\n  }"),
];

fn guarded(guard: &str, body: &str) -> String {
    if guard.contains("BODY") { guard.replace("  BODY", body) } else { format!("{guard}\n{body}") }
}

#[test]
fn unguarded_each_position_is_refused() {
    for (position, body) in POSITIONS {
        assert_eq!(absent(body).len(), 1, "{position}");
    }
}

#[test]
fn a_branch_that_always_leaves_proves_the_record_there_below_it() {
    for (position, body) in POSITIONS {
        for (guard, text) in GUARDS {
            assert_eq!(absent(&guarded(text, body)), Vec::<String>::new(), "{position}, guarded by {guard}");
        }
    }
}

#[test]
fn a_branch_that_can_fall_through_proves_nothing_below_it() {
    for (position, body) in POSITIONS {
        for (guard, text) in NOT_GUARDS {
            assert_eq!(absent(&guarded(text, body)).len(), 1, "{position}, after {guard}");
        }
    }
}

#[test]
fn the_right_side_of_a_presence_test_sees_the_record_there() {
    assert_eq!(absent("  return x != null && count(x-[:Messages]->) > 0"), Vec::<String>::new());
    assert_eq!(absent("  return x == null || count(x-[:Messages]->) > 0"), Vec::<String>::new());
    assert_eq!(absent("  return x != null && x.`Name` == \"a\""), Vec::<String>::new());
    assert_eq!(absent("  return x == null && count(x-[:Messages]->) > 0").len(), 1);
    assert_eq!(absent("  return x != null || count(x-[:Messages]->) > 0").len(), 1);
}
