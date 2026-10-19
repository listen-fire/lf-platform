//! A limiter module lf does not build in: the limiter slot filled by a
//! third-party module (crate::core), spoken to over the limiter slot's
//! methods (docs/contracts/limiter-slot.md) carried as adapter protocol 2
//! calls (crate::slot_client), opened by `limiter.open` with the module's
//! settings. A limiter shared by many hosts (Redis, a database) is such a
//! module; lf's in-process waiting (crate::limiter::acquire) is unchanged by it.

use std::collections::BTreeMap;

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::limiter::{Acquire, Bucket, Grant, Limiter};
use crate::obj;
use crate::slot_client::SlotClient;
use crate::store::iso_at;

pub struct ProcessLimiter {
    client: SlotClient,
}

impl ProcessLimiter {
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessLimiter, String> {
        let limiter = ProcessLimiter { client: SlotClient::start("limiter", name, process, settings)? };
        limiter.call("limiter.open", obj! { "settings" => Js::from(limiter.client.settings()) })?;
        Ok(limiter)
    }

    fn call(&self, method: &str, params: Obj) -> Result<Js, String> {
        self.client.call_text(method, params)
    }
}

impl Limiter for ProcessLimiter {
    fn acquire(&self, request: &Acquire) -> Result<Grant, String> {
        let answer = self.call("limiter.acquire", acquire_params(request))?;
        grant_of(&answer).ok_or_else(|| format!("{}: limiter.acquire answered {}, not a grant", self.client.label, answer.to_json()))
    }

    fn release(&self, permit: &str) -> Result<(), String> {
        self.call("limiter.release", obj! { "permit" => Js::str(permit) }).map(|_| ())
    }

    fn throttle(&self, key: &str, until_ms: i64) -> Result<(), String> {
        self.call("limiter.throttle", obj! { "key" => Js::str(key), "until" => Js::str(iso_at(until_ms)) }).map(|_| ())
    }
}

// ── The wire's shapes, both ways (crate::contract_limiter serves them) ──────

pub fn acquire_params(request: &Acquire) -> Obj {
    let limits = request
        .limits
        .iter()
        .map(|limit| {
            let mut out = obj! { "key" => Js::str(&limit.key) };
            if let Some((calls, per_ms)) = limit.calls {
                out.insert("calls".into(), Js::Num(calls.into()));
                out.insert("perMs".into(), Js::Num(per_ms.into()));
            }
            if let Some(concurrent) = limit.concurrent {
                out.insert("concurrent".into(), Js::Num(concurrent.into()));
            }
            Js::from(out)
        })
        .collect();
    obj! {
        "key" => Js::str(&request.key),
        "cost" => Js::Num(request.cost.into()),
        "limits" => Js::Arr(limits),
        "holdMs" => Js::Num(request.hold_ms.into()),
    }
}

pub fn acquire_of(params: &Js) -> Result<Acquire, String> {
    let whole = |js: &Js, key: &str| -> Result<Option<u64>, String> {
        match js.get(key) {
            None | Some(Js::Null) => Ok(None),
            Some(Js::Num(n)) => n.as_u64().map(Some).ok_or_else(|| format!("{key}: expected a whole number")),
            Some(_) => Err(format!("{key}: expected a whole number")),
        }
    };
    let key = params.get("key").and_then(Js::as_str).ok_or("key: expected a string")?.to_string();
    let limits = params.get("limits").and_then(Js::as_array).ok_or("limits: expected a list")?;
    let limits = limits
        .iter()
        .map(|limit| {
            let key = limit.get("key").and_then(Js::as_str).ok_or("limits[].key: expected a string")?.to_string();
            let calls = match (whole(limit, "calls")?, whole(limit, "perMs")?) {
                (Some(calls), Some(per)) if calls > 0 && per > 0 => Some((calls, per)),
                (None, None) => None,
                _ => return Err("limits[]: calls and perMs go together, each above 0".to_string()),
            };
            Ok(Bucket { key, calls, concurrent: whole(limit, "concurrent")? })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Acquire { key, cost: whole(params, "cost")?.unwrap_or(1), limits, hold_ms: whole(params, "holdMs")?.unwrap_or(crate::limiter::HOLD_MS) })
}

pub fn grant_wire(grant: &Grant) -> Js {
    Js::from(match grant {
        Grant::Granted { permit } => obj! { "granted" => Js::Bool(true), "permit" => Js::str(permit) },
        Grant::Refused { retry_at_ms } => obj! { "granted" => Js::Bool(false), "retryAt" => Js::str(iso_at(*retry_at_ms)) },
    })
}

fn grant_of(answer: &Js) -> Option<Grant> {
    match answer.get("granted") {
        Some(Js::Bool(true)) => Some(Grant::Granted { permit: answer.get("permit")?.as_str()?.to_string() }),
        Some(Js::Bool(false)) => Some(Grant::Refused { retry_at_ms: crate::units::ms_of(answer.get("retryAt")?.as_str()?)? }),
        _ => None,
    }
}
