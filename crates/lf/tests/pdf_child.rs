//! `lf --pdf-text`, the hidden reader process the host parses PDFs in.
#![cfg(feature = "pdf")]

use std::io::Write;
use std::process::{Command, Stdio};

fn run(input: &[u8], fault: Option<&str>) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lf"));
    command.arg("--pdf-text").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(fault) = fault {
        command.env("LF_PDF_TEXT_FAULT", fault);
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn a_non_pdf_is_answered_as_scanned() {
    let out = run(b"%PDF-1.4 truncated", None);
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap(), r#"{"scanned":{"pages":null}}"#);
}

#[cfg(debug_assertions)]
#[test]
fn a_parser_panic_ends_only_the_child_with_no_answer() {
    let out = run(b"%PDF-1.4", Some("panic"));
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}
