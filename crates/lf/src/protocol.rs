//! Adapter protocol 2's transport: one POST per call
//! (docs/contracts/adapter-protocol.md), the envelope `{ ok, result }` or
//! `{ ok: false, error }`, both over HTTP 200. The same request the TypeScript
//! client writes (movement-engine `protocol/client.ts` `postRpc`), failing
//! with the same errors: a transport error for a non-2xx answer, a protocol
//! error carrying the server's `{code, message}`, a shape error for an
//! envelope that is neither.
//!
//! Over a Unix socket, plain HTTP or HTTPS (crate::module_transport), with
//! the install's outgoing auth (crate::outgoing_auth) for a module behind a
//! platform's own sign-in; no retry: the TypeScript client retries nothing
//! either.

use serde_json::json;

use crate::json::Js;
use crate::outgoing_auth::OutgoingAuth;

pub use module_wire::envelope::{ADAPTER_TEAM_HEADER, CREDENTIAL_REFUSED_CODE, PROTOCOL_VERSION, shape_error};

/// What a request carries beside its params: the one credential the
/// connection names, and the install's settings.
#[derive(Default)]
pub struct Carried {
    pub credential: Option<serde_json::Value>,
    pub settings: Option<serde_json::Value>,
}

tokio::task_local! {
    /// Where the `cost` lines of answers are collected, while a run's call
    /// is served (`spending`).
    static SPEND: std::rc::Rc<std::cell::RefCell<Vec<(String, f64)>>>;
}

/// Run `call`, collecting what the answers it receives say they spent (an
/// answer's `cost`: label and microdollars). Outside this, a cost is dropped:
/// nothing runs on a run's behalf there.
pub async fn spending<T>(call: impl std::future::Future<Output = T>) -> (T, Vec<(String, f64)>) {
    let lines = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let out = SPEND.scope(lines.clone(), call).await;
    let spent = lines.borrow().clone();
    (out, spent)
}

fn record_cost(envelope: &Js) {
    let lines: Vec<(String, f64)> = envelope
        .get("cost")
        .and_then(Js::as_array)
        .into_iter()
        .flatten()
        .filter_map(|line| Some((line.get("label")?.as_str()?.to_string(), match line.get("microdollars")? { Js::Num(n) => n.as_f64()?, _ => return None })))
        .filter(|(_, micro)| micro.is_finite() && *micro >= 0.0)
        .collect();
    if lines.is_empty() {
        return;
    }
    let _ = SPEND.try_with(|spend| spend.borrow_mut().extend(lines));
}

pub struct Call<'a> {
    pub base_url: &'a str,
    /// The `Authorization` header's value, when the external authenticates.
    pub bearer: Option<&'a str>,
    pub team_id: &'a str,
    pub method: &'a str,
    /// The caller's cache scope (`cacheScopeId`): one per adapter instance.
    pub cache_scope_id: &'a str,
    pub params: serde_json::Value,
    /// How the call proves itself to the platform in front of the module.
    pub auth: Option<OutgoingAuth>,
}

/// Why a protocol call failed, by the TypeScript error it stands for.
#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    /// `fetch` itself failed: nothing answered.
    Unreachable(String),
    /// `RemoteTransportError`: a non-2xx answer.
    Transport { status: u16, method: String },
    /// `RemoteProtocolError`: the server's `{ ok: false, error }`.
    Protocol { code: String, message: String, method: String },
    /// `RemoteResponseShapeError`: an answer that is not the protocol's.
    Shape(String),
}

impl RpcError {
    pub fn message(&self) -> String {
        match self {
            RpcError::Unreachable(message) | RpcError::Shape(message) => message.clone(),
            RpcError::Transport { status, method } => format!("Remote adapter transport error (HTTP {status}) for method \"{method}\""),
            RpcError::Protocol { code, message, method } => format!("Remote adapter error for method \"{method}\": {code} — {message}"),
        }
    }

    /// The TypeScript error's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            RpcError::Unreachable(_) => "TypeError",
            RpcError::Transport { .. } => "RemoteTransportError",
            RpcError::Protocol { .. } => "RemoteProtocolError",
            RpcError::Shape(_) => "RemoteResponseShapeError",
        }
    }

    /// The HTTP status a transport error carries.
    pub fn status(&self) -> Option<u16> {
        match self {
            RpcError::Transport { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl From<RpcError> for String {
    fn from(error: RpcError) -> String {
        error.message()
    }
}

/// One protocol call: its `result`, or why it failed. With a module's
/// declared credential it carries it (the request's `credential`), and the
/// answer's `credentialUpdate` comes back beside the result — read on a
/// failed answer too, since a rotated refresh token must be stored either way.
/// A call's answer, and what rode beside it: a `credentialUpdate`, and the
/// provider's throttle (`retryAfter`, here in milliseconds).
pub struct Answered {
    pub answer: Result<Js, RpcError>,
    pub update: Option<Js>,
    pub retry_after_ms: Option<u64>,
}

pub async fn post_rpc_carrying(call: Call<'_>, carried: Carried) -> Answered {
    let mut beside = Beside::default();
    let (method, base_url, limit) = (call.method.to_string(), call.base_url.to_string(), crate::module_hosts::call_timeout());
    // A call that outlasts the limit fails as an unreachable one does: the
    // run's own retry and failure path takes it from there.
    let answer = tokio::time::timeout(limit, post(call, carried, &mut beside)).await.unwrap_or_else(|_| {
        Err(RpcError::Unreachable(format!(
            "Remote adapter at {base_url} did not answer \"{method}\" within {}s (lf.yaml's `callTimeout` allows longer)",
            limit.as_secs()
        )))
    });
    Answered { answer, update: beside.update, retry_after_ms: beside.retry_after_ms }
}

#[derive(Default)]
struct Beside {
    update: Option<Js>,
    retry_after_ms: Option<u64>,
}

/// The request envelope's headers: the content type, the calling team, the
/// module's own secret, and the install's outgoing auth.
pub async fn envelope_headers(team_id: &str, bearer: Option<&str>, auth: Option<&OutgoingAuth>) -> Result<Vec<(String, String)>, String> {
    let mut headers = vec![("content-type".to_string(), "application/json".to_string()), (ADAPTER_TEAM_HEADER.to_string(), team_id.to_string())];
    if let Some(secret) = bearer {
        headers.push(("authorization".into(), format!("Bearer {secret}")));
    }
    if let Some(auth) = auth {
        let header = auth.header(&headers).await?;
        headers.push(header);
    }
    Ok(headers)
}

async fn post(call: Call<'_>, carried: Carried, beside: &mut Beside) -> Result<Js, RpcError> {
    let unreachable = |e: &dyn std::fmt::Display| {
        RpcError::Unreachable(format!("Remote adapter at {} could not be reached for method \"{}\": {e}", call.base_url, call.method))
    };
    let mut body = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "method": call.method,
        "cacheScopeId": call.cache_scope_id,
        "params": call.params,
    });
    for (key, value) in [("credential", carried.credential), ("settings", carried.settings)] {
        if let Some(value) = value {
            body[key] = value;
        }
    }
    let headers = envelope_headers(call.team_id, call.bearer, call.auth.as_ref()).await.map_err(|e| unreachable(&e))?;
    let answer = crate::module_transport::post(call.base_url, &headers, body.to_string().into_bytes()).await.map_err(|e| unreachable(&e))?;
    if !(200..300).contains(&answer.status) {
        return Err(RpcError::Transport { status: answer.status, method: call.method.to_string() });
    }
    let bytes = answer.body;
    let envelope = Js::parse(&bytes).map_err(|e| {
        RpcError::Shape(format!("Remote adapter \"{}\" answered \"{}\" with a body that is not JSON: {e}", call.base_url, call.method))
    })?;
    beside.update = envelope.get("credentialUpdate").cloned();
    beside.retry_after_ms = match envelope.get("retryAfter") {
        Some(Js::Num(seconds)) => seconds.as_f64().filter(|s| s.is_finite() && *s >= 0.0).map(|s| (s * 1000.0).ceil() as u64),
        _ => None,
    };
    record_cost(&envelope);
    match envelope.get("ok") {
        Some(Js::Bool(true)) => Ok(envelope.get("result").cloned().unwrap_or(Js::Null)),
        Some(Js::Bool(false)) => {
            let error = envelope.get("error");
            let field = |k: &str| error.and_then(|e| e.get(k)).and_then(Js::as_str);
            match (field("code"), field("message")) {
                (Some(code), Some(message)) => {
                    Err(RpcError::Protocol { code: code.to_string(), message: message.to_string(), method: call.method.to_string() })
                }
                _ => Err(RpcError::Shape(shape_error(call.method, call.base_url, &envelope, "error: expected { code, message }"))),
            }
        }
        _ => Err(RpcError::Shape(shape_error(call.method, call.base_url, &envelope, "ok: expected true or false"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_failure_carries_the_typescript_errors_words() {
        let protocol = RpcError::Protocol { code: "internal".into(), message: "boom".into(), method: "describe".into() };
        assert_eq!(protocol.message(), "Remote adapter error for method \"describe\": internal — boom");
        assert_eq!(protocol.name(), "RemoteProtocolError");
        let transport = RpcError::Transport { status: 502, method: "getRelated".into() };
        assert_eq!(transport.message(), "Remote adapter transport error (HTTP 502) for method \"getRelated\"");
        assert_eq!(transport.status(), Some(502));
    }
}
