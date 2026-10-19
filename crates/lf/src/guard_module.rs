//! A loop guard module lf does not build in: the loopGuard slot filled by a
//! third-party module (crate::core), spoken to over the slot's methods
//! (docs/contracts/loop-guard-slot.md) carried as adapter protocol 2 calls
//! (crate::slot_client), opened by `guard.open` with the module's settings.

use std::collections::BTreeMap;

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::loop_guard::{Answer, Asked, LoopGuard, Wrote};
use crate::obj;
use crate::slot_client::SlotClient;

pub struct ProcessGuard {
    client: SlotClient,
}

impl ProcessGuard {
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessGuard, String> {
        let guard = ProcessGuard { client: SlotClient::start("loop guard", name, process, settings)? };
        guard.call("guard.open", obj! { "settings" => Js::from(guard.client.settings()) })?;
        Ok(guard)
    }

    fn call(&self, method: &str, params: Obj) -> Result<Js, String> {
        self.client.call_text(method, params)
    }
}

impl LoopGuard for ProcessGuard {
    fn record_write(&self, wrote: &Wrote, writer: &str) -> Result<(), String> {
        let params = obj! {
            "adapter" => Js::str(&wrote.adapter),
            "recordType" => Js::str(&wrote.record_type),
            "externalId" => Js::str(&wrote.external_id),
            "writer" => Js::str(writer),
            "record" => wrote.record.clone(),
        };
        self.call("guard.recordWrite", params).map(|_| ())
    }

    fn is_echo(&self, asked: &Asked) -> Result<Answer, String> {
        let answer = self.call("guard.isEcho", asked_params(asked))?;
        answer_of(&answer).ok_or_else(|| format!("{}: guard.isEcho answered {}, not an echo or a record to read", self.client.label, answer.to_json()))
    }
}

// ── The wire's shapes, both ways (crate::contract_guard serves them) ────────

pub fn asked_params(asked: &Asked) -> Obj {
    let mut out = obj! { "adapter" => Js::str(asked.adapter), "externalId" => Js::str(asked.external_id), "writer" => Js::str(asked.writer) };
    if let Some(current) = asked.current {
        out.insert("current".into(), Js::from(obj! { "recordType" => Js::str(current.record_type), "record" => current.record.clone() }));
    }
    out
}

pub fn answer_wire(answer: &Answer) -> Js {
    Js::from(match answer {
        Answer::Echo(echo) => obj! { "echo" => Js::Bool(*echo) },
        Answer::Read { record_type } => obj! { "read" => Js::from(obj! { "recordType" => Js::str(record_type) }) },
    })
}

fn answer_of(answer: &Js) -> Option<Answer> {
    match answer.get("echo") {
        Some(Js::Bool(echo)) => Some(Answer::Echo(*echo)),
        _ => Some(Answer::Read { record_type: answer.get("read")?.get("recordType")?.as_str()?.to_string() }),
    }
}
