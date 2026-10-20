//! The limits door (docs/adapter-protocol.md, "The limits door"): how a
//! module's own requests to its provider are counted against the limits it
//! declared, rather than lf's calls to it. One lf call can become several
//! provider requests and retries inside the module, which a count per call
//! misses.
//!
//! A module that declares `hostLimits` is handed, on each call lf makes to
//! it, the door's URL and a ticket for that call (the request's
//! `hostLimits`). Before each provider request it asks the door; the door
//! answers from the limiter slot under the caller lf resolved for the call
//! (module, install, credential, team), so the module never sees a counter
//! or a scope's value, only an opaque ticket. lf does not count that call
//! itself: each request is counted once, at the door.
//!
//! The door never waits, as the slot's own contract never does: it answers
//! granted (a permit) or "ask again after this long". A ticket is good until
//! its call answers; the permits its module still holds then are released.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use crate::json::Js;
use crate::limiter::{Acquire, Grant, Limiter, now_ms};
use crate::obj;

/// The door's last path segment: `{host}/api/public/adapter/{module}/limits`.
pub const DOOR_VERB: &str = "limits";

struct Open {
    module: String,
    request: Acquire,
    limiter: Arc<dyn Limiter>,
    permits: Vec<String>,
}

static OPEN: LazyLock<Mutex<HashMap<String, Open>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn open() -> std::sync::MutexGuard<'static, HashMap<String, Open>> {
    OPEN.lock().unwrap_or_else(|p| p.into_inner())
}

/// One call's ticket: good until dropped, when lf has its answer.
pub struct Ticket {
    ticket: String,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let Some(open) = open().remove(&self.ticket) else { return };
        for permit in &open.permits {
            if let Err(message) = open.limiter.release(permit) {
                eprintln!("lf: the limiter did not release a permit \"{}\" left held: {message}", open.module);
            }
        }
    }
}

/// The door to hand a call to the module at `base_url` (its `hostLimits`),
/// counting under `request`; None where lf serves no door the module can
/// reach (no listener in this process, or a module on another box), and
/// lf then counts the call itself.
pub fn offer(module: &str, base_url: &str, request: Acquire, limiter: Arc<dyn Limiter>) -> Result<Option<(Ticket, serde_json::Value)>, String> {
    let Some(url) = door_url(crate::serve::externals_host_url(), module, base_url) else { return Ok(None) };
    let ticket = crate::http_out::hex(&crate::http_out::random_bytes(24)?);
    open().insert(ticket.clone(), Open { module: module.to_string(), request, limiter, permits: Vec::new() });
    let carried = serde_json::json!({ "url": url, "ticket": ticket });
    Ok(Some((Ticket { ticket }, carried)))
}

/// Where the module at `base_url` reaches this process's door: lf's
/// doors listen on loopback, so only a module on this box can.
fn door_url(host: Option<&str>, module: &str, base_url: &str) -> Option<String> {
    use crate::module_transport::Address;
    let host = host?;
    if !Address::parse(base_url).is_ok_and(|address| address.is_local()) {
        return None;
    }
    let segment: String = url::form_urlencoded::byte_serialize(module.as_bytes()).collect();
    Some(format!("{}/api/public/adapter/{segment}/{DOOR_VERB}", host.trim_end_matches('/')))
}

/// The door's answer to `body`, presented with `bearer` at the door of
/// `module` (the path's, decoded): its status and JSON.
pub fn answer(module: &str, bearer: Option<&str>, body: &Js) -> (u16, Js) {
    let refuse = |status: u16, error: &str, message: String| (status, Js::Obj(obj! { "error" => Js::str(error), "message" => Js::Str(message) }));
    let bad = |message: &str| refuse(400, "bad_request", format!("{message} (a limits door request is {{ op: acquire }}, {{ op: release, permit }} or {{ op: throttle, retryAfterMs }})"));
    let Some(ticket) = bearer.and_then(|b| b.strip_prefix("Bearer ")) else {
        return refuse(401, "unauthorized", "the door takes the call's ticket as its bearer".into());
    };
    // Held only to read the call: a limiter that is a module is not asked under the lock.
    let (request, limiter) = {
        let open = open();
        match open.get(ticket) {
            Some(call) if call.module == module => (call.request.clone(), call.limiter.clone()),
            Some(call) => return refuse(401, "unauthorized", format!("this ticket is for module \"{}\", not \"{module}\"", call.module)),
            None => return refuse(401, "unauthorized", "no call holds this ticket (its call has answered)".into()),
        }
    };
    let failed = |message: String| refuse(502, "limiter_failed", message);
    match body.get("op").and_then(Js::as_str) {
        Some("acquire") => match limiter.acquire(&request) {
            Ok(Grant::Granted { permit }) => {
                let held = match open().get_mut(ticket) {
                    Some(call) => {
                        call.permits.push(permit.clone());
                        true
                    }
                    None => false,
                };
                if !held {
                    // The call answered meanwhile: nobody would release it.
                    let _ = limiter.release(&permit);
                    return refuse(401, "unauthorized", "no call holds this ticket (its call has answered)".into());
                }
                (200, Js::Obj(obj! { "outcome" => Js::str("granted"), "permit" => Js::Str(permit) }))
            }
            Ok(Grant::Refused { retry_at_ms }) => {
                let wait = u64::try_from(retry_at_ms.saturating_sub(now_ms())).unwrap_or(0);
                (200, Js::Obj(obj! { "outcome" => Js::str("wait"), "retryAfterMs" => Js::Num(wait.into()) }))
            }
            Err(message) => failed(message),
        },
        Some("release") => {
            let Some(permit) = body.get("permit").and_then(Js::as_str) else { return bad("release: expected `permit`") };
            let held = open().get_mut(ticket).and_then(|call| call.permits.iter().position(|p| p == permit).map(|at| call.permits.swap_remove(at))).is_some();
            if !held {
                // Released already, or never this call's: nothing to free.
                return (200, Js::Obj(obj! {}));
            }
            match limiter.release(permit) {
                Ok(()) => (200, Js::Obj(obj! {})),
                Err(message) => failed(message),
            }
        }
        Some("throttle") => {
            let Some(after) = body.get("retryAfterMs").and_then(|n| if let Js::Num(n) = n { n.as_u64() } else { None }) else {
                return bad("throttle: expected `retryAfterMs`, a whole number of milliseconds");
            };
            match limiter.throttle(&request.key, now_ms().saturating_add(i64::try_from(after).unwrap_or(i64::MAX))) {
                Ok(()) => (200, Js::Obj(obj! {})),
                Err(message) => failed(message),
            }
        }
        _ => bad("expected `op`"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limiter::{Caller, DeclaredLimit, MemoryLimiter, Scope};

    const MODULE: &str = "@acme/crm";

    fn caller() -> Caller<'static> {
        Caller { module: MODULE, install: Some("crm"), credential: Some("alice_crm"), team: "local" }
    }

    /// A ticket as `offer` opens one, without the listener `offer` needs.
    fn ticket_for(limits: &[DeclaredLimit], limiter: Arc<dyn Limiter>) -> (Ticket, String) {
        let ticket = crate::http_out::hex(&crate::http_out::random_bytes(24).unwrap());
        open().insert(ticket.clone(), Open { module: MODULE.into(), request: caller().request(limits), limiter, permits: Vec::new() });
        (Ticket { ticket: ticket.clone() }, format!("Bearer {ticket}"))
    }

    fn ask(bearer: &str, body: &str) -> (u16, Js) {
        answer(MODULE, Some(bearer), &Js::parse(body.as_bytes()).unwrap())
    }

    fn outcome(answer: &(u16, Js)) -> &str {
        answer.1.get("outcome").and_then(Js::as_str).unwrap_or("")
    }

    #[test]
    fn each_request_is_counted_against_the_declared_limits() {
        let limiter: Arc<dyn Limiter> = Arc::new(MemoryLimiter::default());
        let limits = [DeclaredLimit { scope: Scope::Credential, calls: Some((2, 60_000)), concurrent: None }];
        let (_ticket, bearer) = ticket_for(&limits, limiter);
        assert_eq!(outcome(&ask(&bearer, r#"{"op":"acquire"}"#)), "granted");
        assert_eq!(outcome(&ask(&bearer, r#"{"op":"acquire"}"#)), "granted");
        let refused = ask(&bearer, r#"{"op":"acquire"}"#);
        assert_eq!(outcome(&refused), "wait");
        let Some(Js::Num(wait)) = refused.1.get("retryAfterMs") else { panic!("{}", refused.1.to_json()) };
        assert!(wait.as_u64().is_some_and(|ms| ms > 0 && ms <= 30_000), "{wait}");
    }

    #[test]
    fn a_release_frees_a_concurrent_place_and_the_call_ending_frees_the_rest() {
        let limiter: Arc<dyn Limiter> = Arc::new(MemoryLimiter::default());
        let limits = [DeclaredLimit { scope: Scope::Module, calls: None, concurrent: Some(1) }];
        let (ticket, bearer) = ticket_for(&limits, limiter.clone());
        let granted = ask(&bearer, r#"{"op":"acquire"}"#);
        let permit = granted.1.get("permit").and_then(Js::as_str).unwrap().to_string();
        assert_eq!(outcome(&ask(&bearer, r#"{"op":"acquire"}"#)), "wait");
        assert_eq!(ask(&bearer, &format!(r#"{{"op":"release","permit":"{permit}"}}"#)).0, 200);
        assert_eq!(outcome(&ask(&bearer, r#"{"op":"acquire"}"#)), "granted");
        // The module never released that one: the call answering does.
        drop(ticket);
        assert_eq!(ask(&bearer, r#"{"op":"acquire"}"#).0, 401, "the ticket ends with its call");
        let (_next, bearer) = ticket_for(&limits, limiter);
        assert_eq!(outcome(&ask(&bearer, r#"{"op":"acquire"}"#)), "granted");
    }

    #[test]
    fn a_providers_too_many_requests_holds_the_next_request() {
        let limiter: Arc<dyn Limiter> = Arc::new(MemoryLimiter::default());
        let (_ticket, bearer) = ticket_for(&[], limiter.clone());
        assert_eq!(outcome(&ask(&bearer, r#"{"op":"acquire"}"#)), "granted");
        assert_eq!(ask(&bearer, r#"{"op":"throttle","retryAfterMs":5000}"#).0, 200);
        assert_eq!(outcome(&ask(&bearer, r#"{"op":"acquire"}"#)), "wait");
        // lf's own calls as the same credential are held by it too.
        assert!(matches!(limiter.acquire(&caller().request(&[])).unwrap(), Grant::Refused { .. }));
    }

    #[test]
    fn the_door_takes_only_an_open_ticket_at_its_own_modules_door() {
        let (_ticket, bearer) = ticket_for(&[], Arc::new(MemoryLimiter::default()));
        let acquire = Js::parse(br#"{"op":"acquire"}"#).unwrap();
        assert_eq!(answer(MODULE, None, &acquire).0, 401);
        assert_eq!(answer(MODULE, Some("Bearer nope"), &acquire).0, 401);
        assert_eq!(answer("@acme/other", Some(&bearer), &acquire).0, 401);
        assert_eq!(ask(&bearer, r#"{"op":"throttle"}"#).0, 400);
        assert_eq!(ask(&bearer, r#"{"op":"wait"}"#).0, 400);
    }

    #[test]
    fn a_door_is_offered_only_by_a_listening_lf_to_a_module_on_this_box() {
        let host = Some("http://127.0.0.1:7777");
        assert_eq!(door_url(host, MODULE, "http://127.0.0.1:5557/").as_deref(), Some("http://127.0.0.1:7777/api/public/adapter/%40acme%2Fcrm/limits"));
        assert!(door_url(host, MODULE, "unix:/tmp/lf-1.sock").is_some());
        assert_eq!(door_url(host, MODULE, "https://crm.example.com/rpc"), None);
        assert_eq!(door_url(None, MODULE, "http://127.0.0.1:5557/"), None);
    }
}
