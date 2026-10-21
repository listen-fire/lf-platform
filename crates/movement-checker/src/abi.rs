//! The checker's C ABI answer, exported by the WASM artifact that links this
//! crate (the engine's `movement.wasm`, from its own abi). Same conventions as the parser's
//! (`movement_parser::abi`): inputs are UTF-8 the caller placed with `alloc`,
//! the JSON answer's pointer and length go to the two out slots, and the
//! caller `dealloc`s it.

use movement_parser::abi::{install_panic_hook, utf8, write_out};

use crate::CheckOptions;

/// `check_program(source, catalog snapshot JSON, version, upgrading_from)`
/// against the host's zone database: writes `{diagnostics}` and returns 0,
/// or writes `{error}` and returns 1. `upgrading_from` is 0 for none. The
/// artifact's C export is the engine's (`movement_engine::abi`), which
/// supplies its own environment services as the zone database.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[allow(clippy::too_many_arguments)] // the C export's arguments, passed through
pub unsafe fn check_program_with(
    zones: &dyn crate::host::ZoneLookup,
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    version: u32,
    upgrading_from: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let inputs = unsafe { utf8(src_ptr, src_len, "source") }
        .and_then(|source| unsafe { utf8(catalog_ptr, catalog_len, "catalog") }.map(|catalog| (source, catalog)));
    let answer = match inputs {
        Ok((source, catalog)) => crate::check_json(
            source,
            catalog,
            CheckOptions { language_version: version, upgrading_from: (upgrading_from != 0).then_some(upgrading_from), parse_version: None, zones },
        ),
        Err(error) => serde_json::json!({ "error": error }),
    };
    let status = u32::from(answer.get("error").is_some());
    // Out as `JSON.stringify` writes: the engine's text form undone.
    let bytes = movement_parser::util::form::external_bytes(movement_parser::to_sorted_json(&answer));
    unsafe { write_out(bytes, out_ptr_ptr, out_len_ptr) };
    status
}

/// `check_answer(source, catalog snapshot JSON, version, upgrading_from)`:
/// `check_program_with`'s inputs, answered `{diagnostics, stamps, link?}`
/// (crate::answer) and 0, or `{error}` and 1. What a host answers the
/// engine's `check.program` request with.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[allow(clippy::too_many_arguments)] // the C export's arguments, passed through
pub unsafe fn check_answer_with(
    zones: &dyn crate::host::ZoneLookup,
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    version: u32,
    upgrading_from: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let inputs = unsafe { utf8(src_ptr, src_len, "source") }
        .and_then(|source| unsafe { utf8(catalog_ptr, catalog_len, "catalog") }.map(|catalog| (source, catalog)));
    let answer = match inputs {
        Ok((source, catalog)) => crate::check_answer_json(
            source,
            catalog,
            CheckOptions { language_version: version, upgrading_from: (upgrading_from != 0).then_some(upgrading_from), parse_version: None, zones },
        ),
        Err(error) => serde_json::json!({ "error": error }),
    };
    write_answer(&answer, out_ptr_ptr, out_len_ptr)
}

/// `check_compatible(request JSON)`: the engine's `check.compatible` request
/// (crate::compatible), answered `{fits}` or `{undescribed: true}` and 0, or
/// `{error}` and 1.
///
/// # Safety
/// The input range must be readable; the out slots writable.
pub unsafe fn check_compatible_with(request_ptr: *const u8, request_len: u32, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    install_panic_hook();
    let answer = match unsafe { utf8(request_ptr, request_len, "request") } {
        Ok(request) => crate::compatible::compatible_json(request),
        Err(error) => serde_json::json!({ "error": error }),
    };
    write_answer(&answer, out_ptr_ptr, out_len_ptr)
}

/// Writes `answer` out as `JSON.stringify` writes it (the engine's text form
/// undone), and its status: 1 for `{error}`.
fn write_answer(answer: &serde_json::Value, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    let status = u32::from(answer.get("error").is_some());
    let bytes = movement_parser::util::form::external_bytes(movement_parser::to_sorted_json(answer));
    unsafe { write_out(bytes, out_ptr_ptr, out_len_ptr) };
    status
}
