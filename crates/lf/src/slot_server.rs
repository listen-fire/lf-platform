//! One of lf's built-in core modules served as a module: its slot's methods
//! as adapter protocol 2 calls over HTTP (docs/contracts/adapter-protocol.md),
//! on a Unix socket (or loopback TCP), so the language-neutral conformance
//! suites (engine-contracts `slots/`, and the run host's, limiter's and loop
//! guard's contract cases) hold it to its slot's meaning over the wire, the
//! same wire a third-party module is held to. `lf --contract-<slot>` runs one.
//!
//! Where it listens: `--listen unix:<path>` or `--listen <port>`, else the
//! environment a host starts a module with (`MODULE_SOCKET`, else `PORT`),
//! else a fresh socket. It prints `listening unix:<path>` or
//! `listening <port>`, and with `MODULE_TOKEN` set requires
//! `Authorization: Bearer <token>`.

use std::path::PathBuf;
use std::rc::Rc;

use crate::http::{Request, Response, header};
use crate::json::{Js, Obj};
use crate::obj;
use crate::protocol::PROTOCOL_VERSION;

/// A method's failure, as the envelope's `error` carries it.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: String,
    pub message: String,
    pub data: Option<Js>,
}

impl Refusal {
    pub fn new(code: &str, message: impl Into<String>) -> Refusal {
        Refusal { code: code.into(), message: message.into(), data: None }
    }
    pub fn bad_request(message: impl Into<String>) -> Refusal {
        Refusal::new("bad_request", message)
    }
    pub fn failed(message: impl Into<String>) -> Refusal {
        Refusal::new("module_error", message)
    }
    pub fn unknown(method: &str) -> Refusal {
        Refusal::new("method_not_implemented", format!("no method \"{method}\""))
    }
}

/// What a module of a slot answers `manifest` with (engine-contracts
/// `slots/wire.ts` `WireSlotManifest`).
pub fn manifest(name: &str, slot: &str, methods: &[&str]) -> Js {
    Js::from(obj! {
        "protocolVersion" => Js::Num(2.into()),
        "name" => Js::str(name),
        "kind" => Js::str("core"),
        "slot" => Js::str(slot),
        "methods" => Js::Arr(methods.iter().map(|m| Js::str(*m)).collect()),
    })
}

pub enum Listen {
    Unix(PathBuf),
    Tcp(u16),
}

impl Listen {
    pub fn of(flag: Option<&str>) -> Result<Listen, String> {
        let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        if let Some(given) = flag {
            return match given.strip_prefix("unix:") {
                Some(path) => Ok(Listen::Unix(PathBuf::from(path))),
                None => given.parse().map(Listen::Tcp).map_err(|_| format!("--listen {given}: expected unix:<path> or a port")),
            };
        }
        if let Some(socket) = env("MODULE_SOCKET") {
            return Ok(Listen::Unix(PathBuf::from(socket)));
        }
        if let Some(port) = env("PORT") {
            return port.parse().map(Listen::Tcp).map_err(|_| format!("PORT={port}: expected a port"));
        }
        Ok(match crate::module_transport::fresh_socket_path() {
            Some(path) => Listen::Unix(path),
            None => Listen::Tcp(0),
        })
    }
}

/// Serve `answer` (method, params, settings → result) until the process ends.
pub async fn serve<A>(listen: Listen, manifest: Js, answer: A) -> Result<(), String>
where
    A: Fn(&str, &Js, &Js) -> Result<Js, Refusal> + 'static,
{
    serve_async(listen, manifest, move |method: String, params: Js, settings: Js| {
        let answered = answer(&method, &params, &settings);
        async move { answered }
    })
    .await
}

/// `serve`, for methods whose answers are awaited (a model's).
pub async fn serve_async<A, F>(listen: Listen, manifest: Js, answer: A) -> Result<(), String>
where
    A: Fn(String, Js, Js) -> F + 'static,
    F: std::future::Future<Output = Result<Js, Refusal>> + 'static,
{
    let token = Rc::new(std::env::var("MODULE_TOKEN").ok().filter(|t| !t.is_empty()));
    let answer = Rc::new(answer);
    let manifest = Rc::new(manifest);
    let handle = move |request: Request| {
        let (token, answer, manifest) = (token.clone(), answer.clone(), manifest.clone());
        async move {
            match read_envelope(&request, token.as_deref()) {
                Err(response) => response,
                Ok((method, _, _)) if method == "manifest" => Response::json(200, &envelope_of(Ok((*manifest).clone()))),
                Ok((method, params, settings)) => Response::json(200, &envelope_of(answer(method, params, settings).await)),
            }
        }
    };
    match listen {
        Listen::Tcp(port) => {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("127.0.0.1:{port}: {e}"))?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            println!("listening {port}");
            crate::http::serve(listener, LIMIT, handle).await;
        }
        #[cfg(unix)]
        Listen::Unix(path) => {
            let _ = std::fs::remove_file(&path);
            let listener = tokio::net::UnixListener::bind(&path).map_err(|e| format!("unix:{}: {e}", path.display()))?;
            println!("listening unix:{}", path.display());
            let removed = Removed(path);
            crate::http::serve_unix(listener, LIMIT, handle).await;
            drop(removed);
        }
        #[cfg(not(unix))]
        Listen::Unix(path) => return Err(format!("unix:{}: this system has no Unix sockets; listen on a port", path.display())),
    }
    Ok(())
}

/// A request body's limit: a files slot's bytes ride in it.
const LIMIT: usize = 64 * 1024 * 1024;

/// Removes the socket file when the server ends.
struct Removed(PathBuf);

impl Drop for Removed {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The request's method, params and settings, or the answer that refuses it.
fn read_envelope(request: &Request, token: Option<&str>) -> Result<(String, Js, Js), Response> {
    if let Some(token) = token
        && header(&request.headers, "authorization") != Some(format!("Bearer {token}").as_str())
    {
        return Err(Response::json(401, &Js::from(obj! { "error" => Js::str("unauthorized") })));
    }
    if request.method != "POST" {
        return Err(Response::json(405, &Js::from(obj! { "error" => Js::str("a module answers POST") })));
    }
    if request.too_large {
        return Err(Response::json(413, &Js::from(obj! { "error" => Js::str("the body is too large") })));
    }
    let bad = || Response::json(400, &Js::from(obj! { "error" => Js::str("bad_request") }));
    let envelope = Js::parse(&request.body).map_err(|_| bad())?;
    let method = envelope.get("method").and_then(Js::as_str).ok_or_else(bad)?.to_string();
    if envelope.get("protocolVersion").and_then(Js::as_str) != Some(PROTOCOL_VERSION) {
        let refused = Refusal::new("protocol_version", format!("this module speaks protocol {PROTOCOL_VERSION}"));
        return Err(Response::json(200, &envelope_of(Err(refused))));
    }
    let empty = || Js::from(Obj::new());
    Ok((method, envelope.get("params").cloned().unwrap_or_else(empty), envelope.get("settings").cloned().unwrap_or_else(empty)))
}

pub fn envelope_of(result: Result<Js, Refusal>) -> Js {
    Js::from(match result {
        Ok(result) => obj! { "ok" => Js::Bool(true), "result" => result },
        Err(refusal) => {
            let retryable = refusal.code == "module_error";
            let mut error = obj! { "code" => Js::str(&refusal.code), "message" => Js::str(&refusal.message), "retryable" => Js::Bool(retryable) };
            if let Some(data) = refusal.data {
                error.insert("data".into(), data);
            }
            obj! { "ok" => Js::Bool(false), "error" => Js::from(error) }
        }
    })
}
