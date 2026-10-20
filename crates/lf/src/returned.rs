//! What a run's movement returned, treated as a cron job's output: every
//! run records it in its history (the `returned` member of the run's
//! outcome), however the run was started; it is shown to a person who
//! started or drove the run (`lf run`, `lf resume`, `lf call`), and it never
//! reaches an external system — no door answers with it, so what a run
//! returns can never be a side door for an effect.
//!
//! As recorded: `{value}`; `{truncated: true, bytes, preview}` for a value
//! whose JSON is over the cap; `{unwritable: why}` for one with no plain
//! form. A file in the value is kept as a reference to the file (its owner
//! and handle), never its bytes or a URL to them.

use crate::json::{Js, Obj};
use crate::obj;
use crate::wire::Hv;

/// The most JSON text a run's history keeps of what it returned. A run's
/// outcome is read back on every segment that settles it and on every
/// `lf runs`, so it stays small; 64 KiB holds any summary a person reads,
/// and anything bigger belongs in a file, which is recorded by reference.
pub const RECORDED_BYTES: usize = 64 * 1024;

/// The value as the run's history keeps it.
pub fn recorded(value: &Hv) -> Js {
    let plain = plain(value);
    let text = plain.to_json();
    if text.len() <= RECORDED_BYTES {
        return Js::Obj(obj! { "value" => plain });
    }
    let mut cut = RECORDED_BYTES;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    Js::Obj(obj! {
        "truncated" => Js::Bool(true),
        "bytes" => Js::Num((text.len() as u64).into()),
        "preview" => Js::str(&text[..cut]),
    })
}

/// A value the engine could not write out, with why.
pub fn unwritable(why: &str) -> Js {
    Js::Obj(obj! { "unwritable" => Js::str(why) })
}

/// The value with each file in it as a reference: its name, type and size,
/// and its owner type and handle (`wireSource`, which names no credential).
fn plain(value: &Hv) -> Js {
    match value {
        Hv::File { descriptor, .. } => {
            let mut reference: Obj = obj! { "__brand" => Js::str("FileRef") };
            for key in ["name", "contentType", "size"] {
                if let Some(member) = descriptor.get(key) {
                    reference.insert(key.into(), member.clone());
                }
            }
            if let Some(source) = crate::file_ref::wire_source(descriptor.get("source")) {
                reference.insert("source".into(), source);
            }
            Js::Obj(reference)
        }
        Hv::List(items) => Js::Arr(items.iter().map(plain).collect()),
        Hv::Obj(entries) => {
            let mut map = Obj::new();
            for (key, member) in entries {
                map.insert(key.clone(), plain(member));
            }
            Js::Obj(map)
        }
        Hv::Record { descriptor, .. } => plain(descriptor),
        Hv::Null | Hv::Bool(_) | Hv::Num(_) | Hv::Str(_) => value.js(),
    }
}

/// What the run's outcome (its row's JSON text) records it returned.
pub fn of_outcome(outcome: Option<&str>) -> Option<Js> {
    let outcome = Js::parse(outcome?.as_bytes()).ok()?;
    outcome.get("returned").cloned()
}

/// The line a person is shown under the run's own.
pub fn shown(recorded: &Js) -> String {
    if let Some(value) = recorded.get("value") {
        return format!("returned {}", value.to_json());
    }
    if let Some(why) = recorded.get("unwritable").and_then(Js::as_str) {
        return format!("returned a value lf cannot record: {why}");
    }
    let bytes = recorded.get("bytes").map(Js::to_json).unwrap_or_default();
    let preview = recorded.get("preview").and_then(Js::as_str).unwrap_or_default();
    format!("returned {bytes} bytes of JSON, more than the {RECORDED_BYTES} the run's history keeps; its start: {preview}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_under_the_cap_is_kept_whole() {
        let value = Hv::of_js(&Js::Obj(obj! { "greeting" => Js::str("Hello, henry!"), "n" => Js::Num(3.into()) }));
        let kept = recorded(&value);
        assert_eq!(kept.to_json(), r#"{"value":{"greeting":"Hello, henry!","n":3}}"#);
        assert_eq!(shown(&kept), r#"returned {"greeting":"Hello, henry!","n":3}"#);
    }

    #[test]
    fn a_value_over_the_cap_keeps_its_start_and_says_it_was_cut() {
        // Two-byte characters, so the cut must find a character boundary.
        let long = "é".repeat(RECORDED_BYTES);
        let kept = recorded(&Hv::Str(long.clone()));
        assert_eq!(kept.get("truncated"), Some(&Js::Bool(true)));
        assert_eq!(kept.get("bytes").map(Js::to_json), Some((long.len() + 2).to_string()));
        let preview = kept.get("preview").and_then(Js::as_str).unwrap();
        assert!(preview.len() <= RECORDED_BYTES && preview.len() > RECORDED_BYTES - 2);
        assert!(preview.starts_with("\"éé"));
        assert!(kept.get("value").is_none());
        assert!(shown(&kept).contains("more than the 65536"));
    }

    #[test]
    fn a_file_is_kept_as_its_reference_never_its_url() {
        let descriptor = obj! {
            "__brand" => Js::str("FileRef"),
            "name" => Js::str("report.pdf"),
            "contentType" => Js::str("application/pdf"),
            "size" => Js::Num(1234.into()),
            "source" => Js::Obj(obj! { "store" => Js::str("document"), "objectUri" => Js::str("lf-files://abc") }),
            "url" => Js::str("data:application/pdf;base64,JVBERi0xLjQK"),
        };
        let value = Hv::Obj(vec![("report".into(), Hv::File { id: 0, descriptor })]);
        let kept = recorded(&value).to_json();
        assert_eq!(
            kept,
            r#"{"value":{"report":{"__brand":"FileRef","name":"report.pdf","contentType":"application/pdf","size":1234,"source":{"ownerAdapterType":"document-store","handle":"lf-files://abc"}}}}"#
        );
        assert!(!kept.contains("base64"));
    }

    #[test]
    fn the_outcome_names_what_was_recorded() {
        assert_eq!(of_outcome(Some(r#"{"writes":0,"returned":{"value":"hi"}}"#)).map(|r| r.to_json()), Some(r#"{"value":"hi"}"#.into()));
        assert_eq!(of_outcome(Some(r#"{"writes":0}"#)), None);
        assert_eq!(of_outcome(None), None);
        assert_eq!(shown(&unwritable("a function")), "returned a value lf cannot record: a function");
    }
}
