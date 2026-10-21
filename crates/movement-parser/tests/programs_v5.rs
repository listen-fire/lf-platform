//! The language's version 5 programs (tests/programs_v5.json, one JSON
//! object per line: `origin` and `source`): the engine's pattern programs and
//! their library files (crates/movement-engine/tests/oracle/patterns.json,
//! without the cases the parser refuses), the examples' movement files, and
//! the handbook's engine-claim probes. Every one parses at version 5, and its
//! eager parse is its plain parse with every slot read.
//!
//!   cargo test -p listen-fire-parser --test programs_v5

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Record {
    origin: String,
    source: String,
}

fn records() -> Vec<Record> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/programs_v5.json");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {path}: {e}"));
    let records: Vec<Record> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(i, line)| serde_json::from_str(line).unwrap_or_else(|e| panic!("programs_v5.json line {}: {e}", i + 1)))
        .collect();
    assert!(records.len() > 500, "programs_v5.json has only {} records", records.len());
    records
}

#[test]
fn every_version_5_program_parses() {
    let refused: Vec<String> = records()
        .iter()
        .filter_map(|record| movement_parser::parse_program(&record.source, 5).err().map(|e| format!("{}: {e}", record.origin)))
        .collect();
    assert!(refused.is_empty(), "{} refused:\n{}", refused.len(), refused.join("\n"));
}

/// The eager export is the plain program plus a parse on every slot: take
/// `tree` / `error` back off and it is the plain output, and every slot —
/// and nothing else, a duration literal's identical `{raw, span}` included —
/// carries exactly one of the two.
#[test]
fn the_eager_program_is_the_plain_one_with_every_slot_parsed() {
    let mut slots = 0usize;
    for record in records() {
        let plain = movement_parser::parse_program(&record.source, 5).unwrap_or_else(|e| panic!("{}: {e}", record.origin));
        let mut eager = movement_parser::parse_program_eager(&record.source, 5)
            .unwrap_or_else(|e| panic!("{}: eager parse failed where the plain one did not: {e}", record.origin));
        slots += strip_slot_parses(&mut eager, None, &record.origin);
        assert_eq!(eager, plain, "{}", record.origin);
    }
    assert!(slots > 3_000, "only {slots} slots seen");
}

/// Removes each slot's `tree`/`error`, checking it had exactly one and that
/// it was where a slot is; returns how many it removed.
fn strip_slot_parses(value: &mut Value, key: Option<&str>, origin: &str) -> usize {
    match value {
        Value::Object(map) => {
            let tree = map.remove("tree");
            let error = map.remove("error");
            let is_braces = map.len() == 2 && map.contains_key("raw") && map.contains_key("span");
            let is_duration = matches!(key, Some("duration" | "every"));
            if is_braces && !is_duration {
                assert!(tree.is_some() != error.is_some(), "slot without exactly one parse in {origin}: {map:?}");
                return 1;
            }
            assert!(tree.is_none() && error.is_none(), "a non-slot was parsed in {origin}: {map:?}");
            map.iter_mut().map(|(k, v)| strip_slot_parses(v, Some(k.as_str()), origin)).sum()
        }
        Value::Array(items) => items.iter_mut().map(|v| strip_slot_parses(v, key, origin)).sum(),
        _ => 0,
    }
}
