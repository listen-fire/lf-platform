//! The language versions the grammar reads. This crate serves language
//! version 5 only: versions 1–4 are the platform's (packages/legacy-lang,
//! with a frozen parser wasm), and every grammar entry refuses them by name.

pub const CURRENT_LANGUAGE_VERSION: u32 = 5;

/// The versions this release parses, checks and runs.
pub const SUPPORTED_LANGUAGE_VERSIONS: &[u32] = &[5];

/// Every version's name, the unsupported ones included, so a refusal can
/// say which version a movement is pinned to.
pub const LANGUAGE_VERSION_NAMES: &[(u32, &str)] =
    &[(1, "Quiet Heron"), (2, "Bright Otter"), (3, "Steady Lynx"), (4, "Luminous Owl"), (5, "Dancing Wren")];

/// `version` has the behaviour version `n` introduced.
pub fn since(version: u32, n: u32) -> bool {
    version >= n
}

/// `version` predates the behaviour version `n` introduced.
pub fn before(version: u32, n: u32) -> bool {
    version < n
}

/// `"Bright Otter" (2)`, or `version 99` for a version the table lacks.
pub fn describe(version: u32) -> String {
    match LANGUAGE_VERSION_NAMES.iter().find(|(v, _)| *v == version) {
        Some((v, name)) => format!("\"{name}\" ({v})"),
        None => format!("version {version}"),
    }
}

/// Why a movement pinned to `version` is not read, or `None` when it is;
/// word for word the checker's standing diagnostic.
pub fn unsupported_message(version: u32) -> Option<String> {
    if SUPPORTED_LANGUAGE_VERSIONS.contains(&version) {
        return None;
    }
    let current = describe(CURRENT_LANGUAGE_VERSION);
    Some(format!(
        "this automation is written in language version {}, which this release does not support, so it will not validate or run. To fix: validate it under {current}, repair what that reports, and upgrade it to {current}.",
        describe(version)
    ))
}

/// The run host's units (Henry 2026-10-16): every file has these names in
/// scope, each already connected — `listen to manual fire hello`,
/// `listen to cron { schedule: "0 9 * * 1" } fire digest` — with no import
/// and no `connect`. A file's own binding of the name replaces it.
pub const RUN_HOST_UNITS: &[&str] = &["cron", "manual"];

/// The units a file pinned to `version` has in scope.
pub fn run_host_units(_version: u32) -> &'static [&'static str] {
    RUN_HOST_UNITS
}
