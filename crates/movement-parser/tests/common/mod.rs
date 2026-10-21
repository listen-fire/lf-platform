//! What the conformance harnesses share: the fixture paths.

use std::path::PathBuf;

pub fn fixture(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/legacy-lang").join(relative)
}
