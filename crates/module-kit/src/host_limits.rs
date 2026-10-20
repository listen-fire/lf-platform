//! The host's limits door (docs/contracts/adapter-protocol.md, "The limits
//! door"): a module whose manifest declares `hostLimits` asks it before each
//! request to its provider, so the limits it declared count those requests,
//! retries included, rather than the host's calls to it. The module sees no
//! counter: a call hands it the door's URL and a ticket, and the host counts
//! under the caller it resolved for that call.
//!
//! A module opts in by declaring `hostLimits` (`.declare("hostLimits",
//! Js::Bool(true))`), only if every provider request takes a permit first:
//! a request made without one is counted by nobody, because the host stops
//! counting calls to a module that declares it. Without the declaration the
//! host counts each call once.
//!
//! This kit has no HTTP client of its own (a module brings its own), so the
//! hook is a permit: take one before each provider request, hand it back
//! after, and say so when the provider answered "too many requests":
//!
//! ```no_run
//! # use module_kit::*;
//! # async fn list(ctx: &Ctx) -> Answer<()> {
//! let permit = ctx.permit().await?;
//! let status = 429; // send the request with your client
//! if status == 429 {
//!     permit.throttled(std::time::Duration::from_secs(30)).await?;
//! } else {
//!     permit.release().await?;
//! }
//! # Ok(())
//! # }
//! ```
//!
//! On a call that hands no door (a host that counted the call itself, or
//! offers none) a permit is granted at once and asks nobody. A permit never
//! handed back is freed by the host when the call answers.

use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use module_wire::json::Js;
use module_wire::obj;

use crate::context::{Answer, Ctx, ModuleError};

/// The door a call handed the module (the request's `hostLimits`).
#[derive(Debug, Clone, PartialEq)]
pub struct HostLimits {
    pub url: String,
    pub ticket: String,
}

impl HostLimits {
    /// The request envelope's `hostLimits`, when it carries one.
    pub fn of(envelope: &Js) -> Option<HostLimits> {
        let door = envelope.get("hostLimits")?;
        let text = |key: &str| door.get(key).and_then(Js::as_str).filter(|v| !v.is_empty()).map(str::to_string);
        Some(HostLimits { url: text("url")?, ticket: text("ticket")? })
    }

    async fn ask(&self, question: Js) -> Answer<Js> {
        let failed = |e: &dyn std::fmt::Display| ModuleError::adapter(format!("the host's limits door at {}: {e}", self.url));
        let (status, body) = post_to_door(&self.url, &self.ticket, question.to_json()).await.map_err(|e| failed(&e))?;
        if !(200..300).contains(&status) {
            return Err(failed(&format!("answered {status}: {}", String::from_utf8_lossy(&body))));
        }
        Js::parse(&body).map_err(|e| failed(&e))
    }
}

/// One JSON POST to a door of the host's on this box (plain HTTP): its
/// status and body.
pub(crate) async fn post_to_door(url: &str, bearer: &str, body: String) -> Result<(u16, Bytes), String> {
    let (authority, path) = url
        .strip_prefix("http://")
        .map(|rest| rest.split_at(rest.find('/').unwrap_or(rest.len())))
        .ok_or("the door is reached over plain HTTP on this box")?;
    let stream = tokio::net::TcpStream::connect(authority).await.map_err(|e| e.to_string())?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::task::spawn_local(connection);
    let request = hyper::Request::post(if path.is_empty() { "/" } else { path })
        .header("host", authority)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {bearer}"))
        .body(Full::new(Bytes::from(body)))
        .map_err(|e| e.to_string())?;
    let response = sender.send_request(request).await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    Ok((status, body))
}

/// Leave to send one request to the provider. Hand it back with
/// [`Permit::release`] or [`Permit::throttled`].
#[must_use = "a permit is handed back once its request is answered"]
pub struct Permit {
    held: Option<(HostLimits, String)>,
}

impl Permit {
    /// The request is answered.
    pub async fn release(self) -> Answer<()> {
        let Some((door, permit)) = self.held else { return Ok(()) };
        door.ask(Js::Obj(obj! { "op" => Js::str("release"), "permit" => Js::Str(permit) })).await.map(drop)
    }

    /// The provider answered "too many requests" and asked for `retry_after`
    /// of quiet: the host holds every request counted with this one until then.
    pub async fn throttled(self, retry_after: Duration) -> Answer<()> {
        if let Some((door, _)) = &self.held {
            let ms = u64::try_from(retry_after.as_millis()).unwrap_or(u64::MAX);
            door.ask(Js::Obj(obj! { "op" => Js::str("throttle"), "retryAfterMs" => Js::Num(ms.into()) })).await?;
        }
        self.release().await
    }
}

impl Ctx {
    /// Leave to send one request to the provider, waiting as long as the
    /// host's limits door says. Granted at once on a call that hands no door.
    pub async fn permit(&self) -> Answer<Permit> {
        let Some(door) = self.host_limits() else { return Ok(Permit { held: None }) };
        loop {
            let grant = door.ask(Js::Obj(obj! { "op" => Js::str("acquire") })).await?;
            match grant.get("outcome").and_then(Js::as_str) {
                Some("granted") => {
                    let permit = grant.get("permit").and_then(Js::as_str).ok_or_else(|| ModuleError::adapter("the host's limits door granted no permit"))?;
                    return Ok(Permit { held: Some((door.clone(), permit.to_string())) });
                }
                Some("wait") => {
                    let ms = match grant.get("retryAfterMs") {
                        Some(Js::Num(n)) => n.as_u64().unwrap_or(0),
                        _ => 0,
                    };
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                }
                _ => return Err(ModuleError::adapter(format!("the host's limits door answered {}, not a grant", grant.to_json()))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;

    /// A door on loopback that answers `wait` to the first acquire, then
    /// grants; every question it is asked, logged.
    async fn door() -> (HostLimits, Rc<RefCell<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Rc::new(RefCell::new(Vec::new()));
        let seen = log.clone();
        tokio::task::spawn_local(async move {
            let acquires = Rc::new(RefCell::new(0));
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let (seen, acquires) = (seen.clone(), acquires.clone());
                let service = hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    let (seen, acquires) = (seen.clone(), acquires.clone());
                    async move {
                        let bearer = request.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                        let path = request.uri().path().to_string();
                        let body = Js::parse(&request.into_body().collect().await.unwrap().to_bytes()).unwrap();
                        seen.borrow_mut().push(format!("{path} {bearer} {}", body.to_json()));
                        let answer = match body.get("op").and_then(Js::as_str) {
                            Some("acquire") => {
                                *acquires.borrow_mut() += 1;
                                if *acquires.borrow() == 1 { r#"{"outcome":"wait","retryAfterMs":20}"# } else { r#"{"outcome":"granted","permit":"p1"}"# }
                            }
                            _ => "{}",
                        };
                        Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(Bytes::from(answer))))
                    }
                });
                tokio::task::spawn_local(hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service));
            }
        });
        (HostLimits { url: format!("http://127.0.0.1:{port}/api/public/adapter/notes/limits"), ticket: "t-1".into() }, log)
    }

    fn ctx_with(door: Option<HostLimits>) -> Ctx {
        Ctx::new(Some("local".into()), None, None, None).with_host_limits(door)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_permit_waits_as_the_door_says_and_a_429_is_reported_before_the_release() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (door, log) = door().await;
                let ctx = ctx_with(Some(door));
                let started = std::time::Instant::now();
                let permit = ctx.permit().await.unwrap();
                assert!(started.elapsed() >= Duration::from_millis(20), "it waited as told");
                permit.throttled(Duration::from_secs(7)).await.unwrap();
                let at = "/api/public/adapter/notes/limits Bearer t-1";
                assert_eq!(
                    *log.borrow(),
                    [
                        format!(r#"{at} {{"op":"acquire"}}"#),
                        format!(r#"{at} {{"op":"acquire"}}"#),
                        format!(r#"{at} {{"op":"throttle","retryAfterMs":7000}}"#),
                        format!(r#"{at} {{"op":"release","permit":"p1"}}"#),
                    ]
                );
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn without_a_door_a_permit_asks_nobody() {
        let ctx = ctx_with(None);
        ctx.permit().await.unwrap().throttled(Duration::from_secs(1)).await.unwrap();
    }

    #[test]
    fn the_door_rides_the_envelope() {
        let envelope = Js::parse(br#"{"hostLimits":{"url":"http://127.0.0.1:1/x","ticket":"t"}}"#).unwrap();
        assert_eq!(HostLimits::of(&envelope), Some(HostLimits { url: "http://127.0.0.1:1/x".into(), ticket: "t".into() }));
        assert_eq!(HostLimits::of(&Js::parse(b"{}").unwrap()), None);
    }
}
