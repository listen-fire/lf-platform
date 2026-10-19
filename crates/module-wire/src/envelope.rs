//! The envelope every protocol call travels in: `{ protocolVersion, method,
//! cacheScopeId, params, credential?, settings? }` in, `{ ok: true, result }`
//! or `{ ok: false, error: { code, message, retryable? } }` out, over HTTP 200.

use crate::json::Js;

pub const PROTOCOL_VERSION: &str = "2";
/// The header naming the calling team (`ADAPTER_TEAM_HEADER`).
pub const ADAPTER_TEAM_HEADER: &str = "x-listen-fire-team";
/// The error code a module answers when the provider refused the request's
/// credential (`CREDENTIAL_REFUSED_CODE`): refreshed and retried once.
pub const CREDENTIAL_REFUSED_CODE: &str = "credential_refused";
/// An unknown method, or one the module does not implement.
pub const METHOD_NOT_IMPLEMENTED_CODE: &str = "method_not_implemented";
/// The module's own code failed.
pub const ADAPTER_ERROR_CODE: &str = "adapter_error";
/// `params` did not match the method's schema, or the module refused them.
pub const BAD_REQUEST_CODE: &str = "bad_request";
/// The request's `protocolVersion` is not [`PROTOCOL_VERSION`].
pub const PROTOCOL_VERSION_CODE: &str = "protocol_version";

/// What came back, as `RemoteResponseShapeError` describes it.
pub fn received(value: &Js) -> String {
    match value {
        Js::Arr(items) => format!("received an array ({} item{})", items.len(), if items.len() == 1 { "" } else { "s" }),
        Js::Null => "received null".into(),
        Js::Obj(map) => format!("received an object with keys [{}]", map.keys().cloned().collect::<Vec<_>>().join(", ")),
        Js::Bool(_) => "received boolean".into(),
        Js::Num(_) => "received number".into(),
        Js::Str(_) => "received string".into(),
    }
}

/// `RemoteResponseShapeError`'s wording: what came back, and what was expected.
pub fn shape_error(method: &str, adapter: &str, received_value: &Js, expected: &str) -> String {
    format!("Remote adapter \"{adapter}\" returned an unexpected shape from \"{method}\": {}. {expected}", received(received_value))
}
