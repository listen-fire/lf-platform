//! `lf --contract-wake-slot`: the project's wake slot served as a wake
//! module, its methods (docs/contracts/wake-slot.md) as adapter protocol 2
//! calls over HTTP (crate::slot_server), each passed on through lf's own
//! client of the module (crate::wake). The conformance cases (module-runtime
//! `module_wire/conformance.ts` `wakeSlotCases`) then hold lf's side of the
//! wire to the same meaning they hold the module to. lf builds no wake in, so
//! there is no `--contract-wake`.

use std::rc::Rc;

use crate::json::Js;
use crate::slot_server::{Listen, Refusal};
use crate::wake::{WAKE_METHODS, Wake, request_of};

pub async fn serve(wake: Rc<dyn Wake>, name: &str, listen: Listen) -> Result<(), String> {
    let manifest = crate::slot_server::manifest(name, "wake", WAKE_METHODS);
    crate::slot_server::serve(listen, manifest, move |method, params, _settings| answer(&*wake, method, params)).await
}

fn answer(wake: &dyn Wake, method: &str, params: &Js) -> Result<Js, Refusal> {
    if !WAKE_METHODS.contains(&method) {
        return Err(Refusal::unknown(method));
    }
    let (when, kind) = request_of(method, params).map_err(|m| Refusal::bad_request(format!("{method}: {m}")))?;
    wake.wake(when, &kind).map(|()| Js::Null).map_err(Refusal::failed)
}
