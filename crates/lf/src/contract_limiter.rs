//! `lf --contract-limiter`: lf's built-in limiter (`@lf/memory-limiter`)
//! served as a limiter module, the limiter slot's methods
//! (docs/contracts/limiter-slot.md) as adapter protocol 2 calls over HTTP
//! (crate::slot_server), so the TypeScript contract suite (movement-engine
//! `services/limiter/contract.ts`) holds it to the meaning every limiter has.
//! `--contract-limiter-slot` serves the project's limiter slot instead, a
//! limiter module included.

use std::sync::Arc;

use crate::json::Js;
use crate::limiter::Limiter;
use crate::limiter_module::{acquire_of, grant_wire};
use crate::slot_server::{Listen, Refusal};

pub const LIMITER_METHODS: &[&str] = &["limiter.open", "limiter.acquire", "limiter.release", "limiter.throttle"];

pub async fn serve(limiter: Arc<dyn Limiter>, listen: Listen) -> Result<(), String> {
    let manifest = crate::slot_server::manifest("@lf/memory-limiter", "limiter", LIMITER_METHODS);
    crate::slot_server::serve(listen, manifest, move |method, params, _settings| answer(&*limiter, method, params)).await
}

fn answer(limiter: &dyn Limiter, method: &str, params: &Js) -> Result<Js, Refusal> {
    let text = |key: &str| params.get(key).and_then(Js::as_str).ok_or_else(|| Refusal::bad_request(format!("{method}: {key}: expected a string")));
    match method {
        // The built-in takes no settings.
        "limiter.open" => Ok(Js::Null),
        "limiter.acquire" => {
            let request = acquire_of(params).map_err(|m| Refusal::bad_request(format!("{method}: {m}")))?;
            limiter.acquire(&request).map(|g| grant_wire(&g)).map_err(Refusal::failed)
        }
        "limiter.release" => limiter.release(text("permit")?).map(|()| Js::Null).map_err(Refusal::failed),
        "limiter.throttle" => {
            let key = text("key")?;
            let until = crate::units::ms_of(text("until")?).ok_or_else(|| Refusal::bad_request(format!("{method}: until: expected an instant")))?;
            limiter.throttle(key, until).map(|()| Js::Null).map_err(Refusal::failed)
        }
        other => Err(Refusal::unknown(other)),
    }
}
