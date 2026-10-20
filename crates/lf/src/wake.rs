//! The wake slot (docs/contracts/wake-slot.md): lf tells a module that work
//! is ready now, or will be at a time, so whatever starts lf's workers (a
//! cloud queue, a scheduled task service) can start one then, instead of a
//! worker running on a tick in case something is due. lf builds none in, so
//! the slot is empty unless lf.yaml names a module: then nobody is told, and
//! the work waits for a drain to find it.
//!
//! Every work row lf writes or puts back with a due time reaches `queued`
//! after the write, the one place the slot is called. A wake that fails is
//! logged, never the work's failure: the row is already in the store, and the
//! scheduled drain (the safety net every deployment keeps) finds it.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::obj;
use crate::slot_client::SlotClient;
use crate::store::iso_at;

pub const WAKE_METHODS: &[&str] = &["wake.now", "wake.at"];

/// When the work a wake announces is due. An instant is epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum When {
    Now,
    At(i64),
}

pub trait Wake {
    /// Work of `kind` (a work row's kind: `fire_event`, `resume_timer`, …) is due `when`.
    fn wake(&self, when: When, kind: &str) -> Result<(), String>;
}

/// A wake module, spoken to over the slot's methods (crate::slot_client).
pub struct ProcessWake {
    client: SlotClient,
}

impl ProcessWake {
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessWake, String> {
        Ok(ProcessWake { client: SlotClient::start("wake", name, process, settings)? })
    }
}

impl Wake for ProcessWake {
    fn wake(&self, when: When, kind: &str) -> Result<(), String> {
        let (method, params) = request(when, kind);
        self.client.call_text(method, params).map(|_| ())
    }
}

// ── The wire's shapes, both ways (crate::contract_wake serves them) ─────────

pub fn request(when: When, kind: &str) -> (&'static str, Obj) {
    match when {
        When::Now => ("wake.now", obj! { "kind" => Js::str(kind) }),
        When::At(at) => ("wake.at", obj! { "kind" => Js::str(kind), "at" => Js::str(iso_at(at)) }),
    }
}

/// A wake read back from the wire: when, and the work's kind.
pub fn request_of(method: &str, params: &Js) -> Result<(When, String), String> {
    let kind = params.get("kind").and_then(Js::as_str).ok_or("kind: expected a string")?.to_string();
    match method {
        "wake.now" => Ok((When::Now, kind)),
        "wake.at" => {
            let at = params.get("at").and_then(Js::as_str).and_then(crate::units::ms_of).ok_or("at: expected an instant")?;
            Ok((When::At(at), kind))
        }
        other => Err(format!("no method \"{other}\"")),
    }
}

// ── The slot, for the session on this thread ────────────────────────────────

// Per thread, as the run host's store is (crate::module_hosts): lf runs on
// one thread, and each test's session keeps its own.
thread_local! {
    static SLOT: RefCell<Option<Rc<dyn Wake>>> = const { RefCell::new(None) };
}

/// The wake the project's slot names, set as its session opens.
pub fn install(wake: Option<Rc<dyn Wake>>) {
    SLOT.with(|slot| *slot.borrow_mut() = wake);
}

/// The wake module lf.yaml names, reached with its settings; None when the slot is empty.
pub fn of_project(project: &crate::project::Project, credentials: &crate::secrets::Credentials) -> Result<Option<Rc<dyn Wake>>, String> {
    let Some(module) = &project.core.wake else { return Ok(None) };
    let Some(process) = &module.process else { return Err(format!("{}: lf builds no wake module in", module.name)) };
    let wake = ProcessWake::start(&module.name, process, &crate::core::settings_of(credentials, module))?;
    Ok(Some(Rc::new(wake)))
}

/// A work row of `kind` was written (or put back) due at `due_at`, None for
/// now. Called after the write, so a worker the wake starts finds the row.
pub fn queued(kind: &str, due_at: Option<&str>) {
    let Some(wake) = SLOT.with(|slot| slot.borrow().clone()) else { return };
    if let Err(message) = wake.wake(when_due(due_at, crate::limiter::now_ms()), kind) {
        eprintln!("lf: the wake slot was not told of {kind} work ({message}); a scheduled drain will find it");
    }
}

/// A due time not after `now` is now. One that does not read as an instant
/// is now too: waking early costs one worker that finds nothing, waking late
/// leaves the work waiting.
fn when_due(due_at: Option<&str>, now: i64) -> When {
    match due_at.and_then(crate::units::ms_of) {
        Some(at) if at > now => When::At(at),
        _ => When::Now,
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::backend::RunHostStore;

    /// A wake module that keeps what it was told.
    #[derive(Default)]
    pub struct Recording {
        pub told: RefCell<Vec<(When, String)>>,
        pub failing: bool,
    }

    impl Wake for Recording {
        fn wake(&self, when: When, kind: &str) -> Result<(), String> {
            self.told.borrow_mut().push((when, kind.to_string()));
            if self.failing { Err("the queue service is down".into()) } else { Ok(()) }
        }
    }

    /// A recording wake installed on this thread.
    pub fn recording() -> Rc<Recording> {
        let wake = Rc::new(Recording::default());
        install(Some(wake.clone()));
        wake
    }

    fn store() -> crate::store::Store {
        let dir = std::env::temp_dir().join(format!("lf-wake-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::store::Store::open(&dir.join("state.db")).unwrap()
    }

    #[test]
    fn a_due_time_in_the_future_is_at_it_and_any_other_is_now() {
        assert_eq!(when_due(None, 1_000), When::Now);
        assert_eq!(when_due(Some(&iso_at(999)), 1_000), When::Now);
        assert_eq!(when_due(Some(&iso_at(1_000)), 1_000), When::Now);
        assert_eq!(when_due(Some(&iso_at(5_000)), 1_000), When::At(5_000));
        assert_eq!(when_due(Some("not an instant"), 1_000), When::Now);
    }

    #[test]
    fn an_empty_slot_tells_no_one_and_a_filled_one_is_told_after_each_write() {
        install(None);
        queued("fire_event", None);
        let wake = recording();
        let at = crate::limiter::now_ms() + 3_600_000;
        queued("resume_timer", Some(&iso_at(at)));
        queued("fire_event", None);
        assert_eq!(*wake.told.borrow(), vec![(When::At(at), "resume_timer".to_string()), (When::Now, "fire_event".to_string())]);
        install(None);
    }

    #[test]
    fn a_failing_wake_loses_no_work() {
        let wake = Rc::new(Recording { failing: true, ..Recording::default() });
        install(Some(wake.clone()));
        let store = store();
        crate::run_host::queue_await_wake(&store, "acme", store.tenant(), "k").unwrap();
        assert_eq!(wake.told.borrow().len(), 1, "the wake was asked");
        let claim = crate::store::ClaimDue { limit: 10, lease_ms: 60_000, due_by: None, kinds: None };
        assert_eq!(RunHostStore::claim_due(&store, &claim).unwrap().len(), 1, "the row is there for a drain");
        install(None);
    }

    #[test]
    fn the_run_hosts_queued_work_is_announced_now_or_at_its_due_time() {
        let wake = recording();
        let store = store();
        let at = crate::limiter::now_ms() + 3_600_000;
        crate::run_host::arm_timer_wake(&store, "run-1", &iso_at(at)).unwrap();
        crate::run_host::queue_await_wake(&store, "acme", store.tenant(), "k").unwrap();
        crate::callbacks::queue_body(&store, "cb-1", store.tenant(), 0, &crate::store::iso(0)).unwrap();
        let told = wake.told.borrow().clone();
        assert_eq!(told, vec![(When::At(at), "resume_timer".into()), (When::Now, "wake_await".into()), (When::Now, "fire_callback".into())]);
        install(None);
    }

    #[test]
    fn a_wake_round_trips_the_wire() {
        for when in [When::Now, When::At(1_700_000_000_123)] {
            let (method, params) = request(when, "poll_listen");
            assert_eq!(request_of(method, &Js::from(params)), Ok((when, "poll_listen".to_string())));
        }
        assert!(request_of("wake.at", &Js::from(obj! { "kind" => Js::str("x"), "at" => Js::str("soon") })).unwrap_err().contains("instant"));
        assert!(request_of("wake.now", &Js::from(obj! {})).unwrap_err().contains("kind"));
    }
}
