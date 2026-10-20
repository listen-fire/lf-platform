//! The run host's rules over the backend families, ported from movement-
//! engine `services/run_host/{rules,drain,lease}.ts`: what a park writes and
//! in which order, when a run counts as complete, how a run that failed or
//! was cancelled is torn down, how a race's losing subtrees are withdrawn,
//! how a parked run's leaves are stepped (claimed, stepped, finished, with
//! deferred races settled once at the end), and the per-run lease every
//! entry into a run holds.
//!
//! Callback-backed awaits are kept by crate::callbacks, not here.

use std::cell::Cell;
use std::future::Future;

use sha2::{Digest, Sha256};

use crate::json::Js;
use crate::obj;
use crate::backend::RunHostStore;
use crate::store::{ClaimedWork, NewWork, POLL_WORK_KIND, Release, StoreError, iso, timer_work_key, timer_work_payload};

/// A minute of silence is a dead process, not a slow one (`RUN_LEASE_TTL_MS`).
pub const RUN_LEASE_TTL_MS: i64 = 60_000;

/// `CANCELLED_BY_OPERATOR`.
pub const CANCELLED_BY_OPERATOR: &str = "Cancelled by an operator";

pub type Result<T> = std::result::Result<T, String>;

fn store<T>(result: std::result::Result<T, StoreError>) -> Result<T> {
    result.map_err(|e| e.to_string())
}

// ── The run lease ───────────────────────────────────────────────────────────

/// A lease this process holds (`HeldRunLease`).
pub struct Lease {
    pub run_id: String,
    pub token: String,
    deadline: Cell<i64>,
    lost: Cell<bool>,
}

fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

impl Lease {
    /// True once this holder can no longer be sure the run is its own.
    pub fn is_lost(&self) -> bool {
        if !self.lost.get() && now_ms() > self.deadline.get() {
            self.lost.set(true);
        }
        self.lost.get()
    }

    async fn renew_forever(&self, store: &dyn RunHostStore) {
        let ttl = RUN_LEASE_TTL_MS;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis((ttl / 3) as u64)).await;
            if self.lost.get() {
                continue;
            }
            let attempted = now_ms();
            if attempted > self.deadline.get() {
                self.lost.set(true);
                continue;
            }
            match store.renew_lease(&self.run_id, &self.token, ttl) {
                Ok(true) => self.deadline.set(attempted + ttl),
                Ok(false) => self.lost.set(true),
                // One failed renewal is not a lost lease: the deadline is.
                Err(_) => {}
            }
        }
    }
}

/// `withRunLease`: `body` under the run's lease, renewed while it runs and
/// released however it ends; None when the lease is held elsewhere.
pub async fn with_run_lease<T>(store: &dyn RunHostStore, run_id: &str, body: impl AsyncFnOnce(&Lease) -> T) -> Result<Option<T>> {
    let deadline = now_ms() + RUN_LEASE_TTL_MS;
    let Some(token) = store.claim_lease(run_id, RUN_LEASE_TTL_MS).map_err(|e| e.to_string())? else { return Ok(None) };
    let lease = Lease { run_id: run_id.to_string(), token, deadline: Cell::new(deadline), lost: Cell::new(false) };
    let value = tokio::select! {
        biased;
        value = body(&lease) => value,
        () = lease.renew_forever(store) => unreachable!("the renewal never ends"),
    };
    // A release that fails lets the lease lapse instead.
    let _ = store.release_lease(run_id, &lease.token);
    Ok(Some(value))
}

// ── A run whose worker was lost ─────────────────────────────────────────────

/// Why the lost-run sweep fails a run.
pub const WORKER_LOST: &str = "worker lost: lease lapsed";

/// Fail each first firing whose worker was lost (the platform's
/// `settleOrphanedRunningRuns`): still `running` while its lease lapsed, or
/// never taken, a lease's length after it started. Each is failed under its
/// own lease, which a live run's worker holds and renews every third of it,
/// so a live run is never touched. The runs it failed.
pub async fn fail_lost_runs(store_: &dyn RunHostStore, limit: i64) -> Result<Vec<String>> {
    let mut failed = Vec::new();
    for run_id in store(store_.lapsed_runs(RUN_LEASE_TTL_MS, limit))? {
        let settled = with_run_lease(store_, &run_id, async |lease: &Lease| -> Result<bool> {
            // Settled meanwhile, by its worker or by another sweep.
            if store(store_.run(&run_id))?.is_none_or(|r| r.status != "running") {
                return Ok(false);
            }
            fail_run(store_, &run_id, WORKER_LOST, Some(&lease.token))
        })
        .await?;
        if settled.transpose()? == Some(true) {
            failed.push(run_id);
        }
    }
    Ok(failed)
}

// ── A work row that keeps failing ───────────────────────────────────────────

/// How long a work row waits before it is tried again when its run was held
/// elsewhere.
pub const BUSY_RETRY_MS: i64 = 5_000;
/// A failed row waits this long, doubled for each attempt it failed, up to
/// FAILED_RETRY_CAP_MS (the platform's backoff, from a slower start: lf's
/// failures are a module or a store refusing, not a lost race).
const FAILED_RETRY_MS: i64 = 30_000;
const FAILED_RETRY_CAP_MS: i64 = 3_600_000;
/// The attempts a row has before it gives up (the platform has no cap).
/// With the backoff that is about three hours of failing: an outage of a
/// module or a provider is waited out, while a row that can never succeed,
/// or that kills its worker each time, stops and says why. A polled
/// listen's row never gives up: its failures are its source's, and polling
/// again is its schedule (dead, its listen would never be polled again).
pub const MAX_WORK_ATTEMPTS: i64 = 10;

fn gives_up(kind: &str) -> bool {
    kind != POLL_WORK_KIND
}

/// When a row that failed its `attempts`-th attempt is tried again, from now.
fn failed_retry_ms(attempts: i64) -> i64 {
    let doublings = u32::try_from(attempts.clamp(1, 17) - 1).unwrap_or(16);
    FAILED_RETRY_MS.saturating_mul(1 << doublings).min(FAILED_RETRY_CAP_MS)
}

/// Whether the row was claimed past its cap: its last attempts never ended
/// (each killed its worker, or outran its lease), so it is not run again.
pub fn past_cap(claimed: &ClaimedWork) -> bool {
    gives_up(&claimed.kind) && claimed.attempts > MAX_WORK_ATTEMPTS
}

/// What became of a row that failed.
pub enum FailedWork {
    /// Released to be tried again after its backoff.
    Retried,
    /// A run it names is held elsewhere: released as busy, to give up later.
    RunBusy,
    /// Dead with `reason`, and these runs failed with it.
    GaveUp { reason: String, runs: Vec<String> },
}

/// A claimed row whose attempt failed with `why`: tried again after its
/// backoff, or given up at its cap.
pub async fn work_failed(store_: &dyn RunHostStore, claimed: &ClaimedWork, why: &str) -> Result<FailedWork> {
    if gives_up(&claimed.kind) && claimed.attempts >= MAX_WORK_ATTEMPTS {
        return give_up_work(store_, claimed, why).await;
    }
    let retry = iso(failed_retry_ms(claimed.attempts));
    store(store_.release_work(&claimed.id, &claimed.claim, Some(&retry), Release::Failed))?;
    crate::wake::queued(&claimed.kind, Some(&retry));
    Ok(FailedWork::Retried)
}

/// The row gives up: the runs it would have stepped fail with why, each
/// under its lease, then the row is kept dead with the same reason. A crash
/// between the two fails the runs again, which changes nothing, and buries
/// the row on its next claim, which is past its cap.
pub async fn give_up_work(store_: &dyn RunHostStore, claimed: &ClaimedWork, why: &str) -> Result<FailedWork> {
    let reason = format!("gave up on its {} work after {} attempts: {why}", claimed.kind, claimed.attempts);
    let runs = runs_of_work(store_, &claimed.kind, &claimed.payload)?;
    for run_id in &runs {
        let failed = with_run_lease(store_, run_id, async |lease: &Lease| fail_run(store_, run_id, &reason, Some(&lease.token))).await?;
        if failed.is_none() {
            let retry = iso(BUSY_RETRY_MS);
            store(store_.release_work(&claimed.id, &claimed.claim, Some(&retry), Release::Busy))?;
            crate::wake::queued(&claimed.kind, Some(&retry));
            return Ok(FailedWork::RunBusy);
        }
        failed.transpose()?;
    }
    store(store_.bury_work(&claimed.id, &claimed.claim, &reason))?;
    Ok(FailedWork::GaveUp { reason, runs })
}

/// The runs a work row would have stepped: a timer's run, a callback body's
/// run, and the runs still parked on a wake's key. An event's row names
/// none (its run, if it started, is the lost-run sweep's).
fn runs_of_work(store_: &dyn RunHostStore, kind: &str, payload: &Js) -> Result<Vec<String>> {
    let text = |k: &str| payload.get(k).and_then(Js::as_str);
    Ok(match kind {
        "resume_timer" => text("runId").map(str::to_string).into_iter().collect(),
        "fire_callback" => match text("callbackId") {
            Some(id) => store(store_.callback(id))?.map(|c| c.run_id).into_iter().collect(),
            None => Vec::new(),
        },
        "wake_await" => match (text("adapterType"), text("correlationKey")) {
            (Some(adapter_type), Some(key)) => {
                let team = text("teamId").unwrap_or(store_.tenant());
                let mut runs: Vec<String> = store(store_.correlated(adapter_type, team, key))?.into_iter().map(|c| c.run_id).collect();
                runs.dedup();
                runs
            }
            _ => Vec::new(),
        },
        _ => Vec::new(),
    })
}

// ── Library texts a park pins ───────────────────────────────────────────────

/// `parkSources.save`: a text named by the sha-256 of its UTF-8 bytes.
pub fn save_source(store_: &dyn RunHostStore, team_id: &str, source: &str) -> Result<String> {
    let digest = Sha256::digest(source.as_bytes());
    let hash = format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>());
    store(store_.put_source(team_id, &hash, source))?;
    Ok(hash)
}

// ── Work the run host queues ────────────────────────────────────────────────

pub fn arm_timer_wake(store_: &dyn RunHostStore, run_id: &str, wake_at: &str) -> Result<()> {
    store(store_.enqueue("resume_timer", &timer_work_key(run_id), &timer_work_payload(run_id), Some(wake_at), None))?;
    crate::wake::queued("resume_timer", Some(wake_at));
    Ok(())
}

/// The wake for one adapter identity, never coalesced.
pub fn queue_await_wake(store_: &dyn RunHostStore, adapter_type: &str, team_id: &str, correlation_key: &str) -> Result<()> {
    let wake = await_wake_work(adapter_type, team_id, correlation_key);
    store(store_.enqueue(&wake.kind, &wake.key, &wake.payload, None, wake.team_id.as_deref()))?;
    crate::wake::queued(&wake.kind, None);
    Ok(())
}

/// The work row of `queue_await_wake`, due now.
pub fn await_wake_work(adapter_type: &str, team_id: &str, correlation_key: &str) -> NewWork {
    NewWork {
        kind: "wake_await".into(),
        key: format!("wake_await:{}", uuid::Uuid::new_v4()),
        payload: Js::Obj(obj! { "adapterType" => Js::str(adapter_type), "teamId" => Js::str(team_id), "correlationKey" => Js::str(correlation_key) }),
        due_at: None,
        team_id: Some(team_id.to_string()),
    }
}

// ── Completion ──────────────────────────────────────────────────────────────

/// `runCompleteWithout`: no join waits and no OTHER leaf is parked.
pub fn run_complete_without(store_: &dyn RunHostStore, run_id: &str, leaf_address: &str) -> Result<bool> {
    if store(store_.has_pending_joins(run_id))? {
        return Ok(false);
    }
    Ok(store(store_.leaves(run_id, true, None, None))?.iter().all(|l| l.address == leaf_address))
}

pub fn run_quiescent(store_: &dyn RunHostStore, run_id: &str) -> Result<bool> {
    if store(store_.has_pending_joins(run_id))? {
        return Ok(false);
    }
    Ok(store(store_.leaves(run_id, true, None, None))?.is_empty())
}

pub fn clear_if_quiescent(store_: &dyn RunHostStore, run_id: &str, fence: Option<&str>) -> Result<bool> {
    if !run_quiescent(store_, run_id)? {
        return Ok(false);
    }
    store(store_.drop_run_state(run_id, fence))?;
    Ok(true)
}

// ── A run that ends without completing ──────────────────────────────────────

pub fn abandon_run(store_: &dyn RunHostStore, run_id: &str, fence: Option<&str>) -> Result<bool> {
    if !store(store_.drop_run_state(run_id, fence))? {
        return Ok(false);
    }
    store(store_.drop_run_correlations(run_id))?;
    store(store_.revoke_run_callbacks(run_id))?;
    Ok(true)
}

pub fn fail_run(store_: &dyn RunHostStore, run_id: &str, message: &str, fence: Option<&str>) -> Result<bool> {
    store(store_.mark_failed(run_id, message))?;
    abandon_run(store_, run_id, fence)
}

pub fn settle_if_cancel_requested(store_: &dyn RunHostStore, run_id: &str, fence: Option<&str>) -> Result<bool> {
    let Some(reason) = store(store_.cancel_request(run_id))? else { return Ok(false) };
    fail_run(store_, run_id, reason.as_deref().unwrap_or(CANCELLED_BY_OPERATOR), fence)?;
    Ok(true)
}

// ── A race's losers ─────────────────────────────────────────────────────────

/// Whether `prefix` is `address` or one of its ancestors, step by step
/// (`s1.b1` is not an ancestor of `s1.b10`).
fn is_ancestor_or_self(prefix: &str, address: &str) -> bool {
    let prefix: Vec<&str> = if prefix.is_empty() { Vec::new() } else { prefix.split('.').collect() };
    let address: Vec<&str> = if address.is_empty() { Vec::new() } else { address.split('.').collect() };
    prefix.len() <= address.len() && prefix.iter().zip(&address).all(|(a, b)| a == b)
}

/// `cancelSubtrees`.
pub fn cancel_subtrees(store_: &dyn RunHostStore, run_id: &str, subtrees: &[String], exclude_leaf: Option<&str>) -> Result<()> {
    if subtrees.is_empty() {
        return Ok(());
    }
    for address in subtrees {
        if movement_engine::address::Address::parse(address).is_none() {
            return Err(format!("not a lexical address: {address}"));
        }
    }
    let in_subtree = |address: &str| Some(address) != exclude_leaf && subtrees.iter().any(|p| is_ancestor_or_self(p, address));
    let doomed: Vec<String> =
        store(store_.leaves(run_id, true, None, None))?.into_iter().map(|l| l.address).filter(|a| in_subtree(a)).collect();
    if !doomed.is_empty() {
        for address in &doomed {
            store(store_.drop_correlation(run_id, address))?;
        }
        store(store_.delete_leaves(run_id, &doomed))?;
    }
    let dead: Vec<String> = store(store_.frames(run_id))?.into_iter().filter(|f| in_subtree(f)).collect();
    if !dead.is_empty() {
        store(store_.delete_frames(run_id, &dead))?;
    }
    Ok(())
}

// ── Stepping a parked run ───────────────────────────────────────────────────

/// One segment the drain asks the host to run.
pub enum StepRequest {
    /// Resume a claimed leaf: re-enter at it, or (a slept timer) step past it.
    Leaf { address: String, state: Js, reenter: bool },
    /// Settle a race whose branches completed in this batch.
    Race { frame_address: String, state: Js },
}

impl StepRequest {
    /// The leaf whose own row goes after its step: what "complete" excludes.
    pub fn completing_address(&self) -> &str {
        match self {
            StepRequest::Leaf { address, .. } => address,
            StepRequest::Race { frame_address, .. } => frame_address,
        }
    }
}

/// What one segment came to (`StepOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub enum StepOutcome {
    LeaseLost,
    Failed(String),
    Cancelled(Option<String>),
    Parked { address: Option<String>, deferred_race_frames: Vec<String> },
    Completed { deferred_race_frames: Vec<String> },
}

/// What runs one segment for a drain.
pub trait Stepper {
    fn step(&self, request: StepRequest) -> impl Future<Output = StepOutcome>;
}

pub enum Settled {
    Continue,
    Done,
    LeaseLost,
}

/// `afterStep`: a failure or a cancel tears the run down and ends the
/// drain; a lost lease ends it leaving every row.
pub fn after_step(store_: &dyn RunHostStore, run_id: &str, fence: Option<&str>, outcome: &StepOutcome) -> Result<Settled> {
    Ok(match outcome {
        StepOutcome::LeaseLost => Settled::LeaseLost,
        StepOutcome::Failed(_) => {
            abandon_run(store_, run_id, fence)?;
            Settled::Done
        }
        StepOutcome::Cancelled(reason) => {
            fail_run(store_, run_id, reason.as_deref().unwrap_or(CANCELLED_BY_OPERATOR), fence)?;
            Settled::Done
        }
        StepOutcome::Parked { .. } | StepOutcome::Completed { .. } => Settled::Continue,
    })
}

/// `drainRun`: step the chosen leaves of one run under the caller's lease.
/// True when the lease went mid-drain (every row is left as it is).
pub async fn drain_run(store_: &dyn RunHostStore, run_id: &str, addresses: &[String], reason: Option<&str>, lease: &Lease, stepper: &impl Stepper) -> Result<bool> {
    let fence = Some(lease.token.as_str());
    if settle_if_cancel_requested(store_, run_id, fence)? {
        return Ok(false);
    }
    let mut deferred: Vec<(String, Js)> = Vec::new();
    for address in addresses {
        if lease.is_lost() {
            return Ok(true);
        }
        let Some((claimed_reason, state)) = store(store_.claim_leaf(run_id, address, reason))? else {
            if lease.is_lost() {
                return Ok(true);
            }
            store(store_.drop_correlation(run_id, address))?;
            continue;
        };
        let until = Js::is_true(state.get("until"));
        let reenter = claimed_reason != "timer" || until;
        let outcome = stepper.step(StepRequest::Leaf { address: address.clone(), state: state.clone(), reenter }).await;
        match after_step(store_, run_id, fence, &outcome)? {
            Settled::Continue => {}
            Settled::Done => return Ok(false),
            Settled::LeaseLost => return Ok(true),
        }
        let (parked_at, frames) = match &outcome {
            StepOutcome::Parked { address, deferred_race_frames } => (address.as_deref(), deferred_race_frames),
            StepOutcome::Completed { deferred_race_frames } => (None, deferred_race_frames),
            _ => continue,
        };
        for frame in frames {
            if !deferred.iter().any(|(f, _)| f == frame) {
                deferred.push((frame.clone(), state.clone()));
            }
        }
        if parked_at != Some(address.as_str()) {
            store(store_.drop_correlation(run_id, address))?;
            store(store_.finish_leaf(run_id, address, fence))?;
        }
    }
    for (frame_address, state) in deferred {
        let outcome = stepper.step(StepRequest::Race { frame_address, state }).await;
        match after_step(store_, run_id, fence, &outcome)? {
            Settled::Continue => {}
            Settled::Done => return Ok(false),
            Settled::LeaseLost => return Ok(true),
        }
    }
    clear_if_quiescent(store_, run_id, fence)?;
    Ok(false)
}

/// `drainDueTimers`.
pub async fn drain_due_timers(store_: &dyn RunHostStore, run_id: &str, due_by: &str, lease: &Lease, stepper: &impl Stepper) -> Result<bool> {
    let due: Vec<String> = store(store_.leaves(run_id, true, Some("timer"), Some(due_by)))?.into_iter().map(|l| l.address).collect();
    drain_run(store_, run_id, &due, Some("timer"), lease, stepper).await
}

/// `nextTimerWake`: the earliest wake of the run's still-parked timers.
pub fn next_timer_wake(store_: &dyn RunHostStore, run_id: &str) -> Result<Option<String>> {
    let mut wakes: Vec<String> = store(store_.leaves(run_id, true, Some("timer"), None))?.into_iter().filter_map(|l| l.wake_at).collect();
    wakes.sort();
    Ok(wakes.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ancestor_is_a_prefix_by_whole_steps() {
        assert!(is_ancestor_or_self("s1.b1", "s1.b1.s0"));
        assert!(is_ancestor_or_self("s1.b1", "s1.b1"));
        assert!(!is_ancestor_or_self("s1.b1", "s1.b10"));
        assert!(!is_ancestor_or_self("s1.b1.s0", "s1.b1"));
    }

    #[test]
    fn a_library_text_is_named_by_its_sha256() {
        let dir = std::env::temp_dir().join(format!("lf-rules-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store_ = crate::store::Store::open(&dir.join("state.db")).unwrap();
        // sha256("abc")
        assert_eq!(save_source(&store_, "local", "abc").unwrap(), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(store_.get_source("local", "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").unwrap().as_deref(), Some("abc"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    use crate::store::{ClaimDue, Store, iso};
    use rusqlite::params;

    fn state_file() -> Store {
        let dir = std::env::temp_dir().join(format!("lf-rules-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Store::open(&dir.join("state.db")).unwrap()
    }

    fn started(store_: &Store, run_id: &str, at: &str) {
        store_.start_run(run_id, "f", "m", at, "{}").unwrap();
    }

    fn lease_until(store_: &Store, run_id: &str, until: &str) {
        store_.db.execute("update run set lease_token = 'dead', lease_until = ? where id = ?", params![until, run_id]).unwrap();
    }

    fn error_of(store_: &Store, run_id: &str) -> Option<String> {
        let row = store_.run(run_id).unwrap().unwrap();
        row.outcome.and_then(|o| Js::parse(o.as_bytes()).ok()).and_then(|o| o.get("error").and_then(Js::as_str).map(str::to_string))
    }

    #[tokio::test]
    async fn the_lost_run_sweep_fails_a_run_whose_lease_lapsed_and_never_a_live_one() {
        let store_ = state_file();
        let long_ago = iso(-5 * RUN_LEASE_TTL_MS);
        started(&store_, "lapsed", &long_ago);
        lease_until(&store_, "lapsed", &iso(-1_000));
        // A long run's worker renews its lease: it is alive, however old.
        started(&store_, "live", &long_ago);
        let token = store_.claim_lease("live", RUN_LEASE_TTL_MS).unwrap().unwrap();
        // Crashed between its row and its first lease.
        started(&store_, "never-leased", &long_ago);
        started(&store_, "just-started", &iso(0));
        assert_eq!(fail_lost_runs(&store_, 100).await.unwrap(), ["lapsed", "never-leased"]);
        for run_id in ["lapsed", "never-leased"] {
            assert_eq!(store_.run(run_id).unwrap().unwrap().status, "failed");
            assert_eq!(error_of(&store_, run_id).as_deref(), Some(WORKER_LOST));
        }
        assert_eq!(store_.run("live").unwrap().unwrap().status, "running");
        assert!(store_.renew_lease("live", &token, RUN_LEASE_TTL_MS).unwrap(), "the live run's lease is still its worker's");
        assert_eq!(store_.run("just-started").unwrap().unwrap().status, "running");
        assert!(fail_lost_runs(&store_, 100).await.unwrap().is_empty(), "a failed run is not failed again");
    }

    fn claim_one(store_: &Store) -> Option<ClaimedWork> {
        // Due by far ahead: each retry's backoff is waited out at once.
        let far = iso(100 * FAILED_RETRY_CAP_MS);
        store_.claim_due(&ClaimDue { limit: 1, lease_ms: 60_000, due_by: Some(&far), kinds: None }).unwrap().pop()
    }

    fn timer_parked(store_: &Store, run_id: &str) {
        started(store_, run_id, &iso(0));
        store_.put_leaf(run_id, "s1", "timer", Some(&iso(-1_000)), &Js::Null, None).unwrap();
        store_.mark_parked(run_id).unwrap();
        arm_timer_wake(store_, run_id, &iso(-1_000)).unwrap();
    }

    #[tokio::test]
    async fn a_failing_row_is_retried_with_a_growing_wait_then_gives_up_and_fails_its_run() {
        let store_ = state_file();
        timer_parked(&store_, "run-1");
        for attempt in 1..MAX_WORK_ATTEMPTS {
            let claimed = claim_one(&store_).unwrap();
            assert_eq!(claimed.attempts, attempt);
            assert!(matches!(work_failed(&store_, &claimed, "boom").await.unwrap(), FailedWork::Retried));
        }
        let last = claim_one(&store_).unwrap();
        let FailedWork::GaveUp { reason, runs } = work_failed(&store_, &last, "boom").await.unwrap() else { panic!("the tenth failure gives up") };
        assert_eq!(reason, "gave up on its resume_timer work after 10 attempts: boom");
        assert_eq!(runs, ["run-1"]);
        assert_eq!(store_.run("run-1").unwrap().unwrap().status, "failed");
        assert_eq!(error_of(&store_, "run-1").as_deref(), Some(reason.as_str()));
        assert!(store_.leaves("run-1", false, None, None).unwrap().is_empty(), "its parks are torn down");
        let dead: Option<String> = store_.db.query_row("select dead_reason from work where key = 'resume_timer:run-1'", [], |r| r.get(0)).unwrap();
        assert_eq!(dead, Some(reason));
        assert!(claim_one(&store_).is_none(), "a dead row is never claimed");
        assert_eq!((failed_retry_ms(1), failed_retry_ms(2), failed_retry_ms(9)), (30_000, 60_000, FAILED_RETRY_CAP_MS));
    }

    #[tokio::test]
    async fn a_row_whose_attempts_never_end_is_past_its_cap_and_a_polled_listens_never_is() {
        let store_ = state_file();
        store_.enqueue("fire_event", "e", &Js::Null, Some(&iso(-1_000))).unwrap();
        store_.enqueue("poll_listen", "p", &Js::Null, Some(&iso(-1_000))).unwrap();
        // Each claim's worker died: its lease lapses at once.
        let lapsing = || store_.claim_due(&ClaimDue { limit: 10, lease_ms: -1, due_by: None, kinds: None }).unwrap();
        for _ in 0..MAX_WORK_ATTEMPTS {
            assert!(lapsing().iter().all(|w| !past_cap(w)));
        }
        let rows = lapsing();
        let event = rows.iter().find(|w| w.kind == "fire_event").unwrap();
        assert!(past_cap(event));
        assert!(!past_cap(rows.iter().find(|w| w.kind == "poll_listen").unwrap()));
        assert!(matches!(work_failed(&store_, rows.iter().find(|w| w.kind == "poll_listen").unwrap(), "source down").await.unwrap(), FailedWork::Retried));
        assert!(matches!(give_up_work(&store_, event, "never finished").await.unwrap(), FailedWork::GaveUp { runs, .. } if runs.is_empty()));
    }

    #[tokio::test]
    async fn a_row_whose_run_is_held_elsewhere_gives_up_later_its_attempt_given_back() {
        let store_ = state_file();
        timer_parked(&store_, "run-1");
        for _ in 1..MAX_WORK_ATTEMPTS {
            let claimed = claim_one(&store_).unwrap();
            work_failed(&store_, &claimed, "boom").await.unwrap();
        }
        let token = store_.claim_lease("run-1", RUN_LEASE_TTL_MS).unwrap().unwrap();
        let last = claim_one(&store_).unwrap();
        assert!(matches!(work_failed(&store_, &last, "boom").await.unwrap(), FailedWork::RunBusy));
        assert_eq!(store_.run("run-1").unwrap().unwrap().status, "parked");
        store_.release_lease("run-1", &token).unwrap();
        let again = claim_one(&store_).unwrap();
        assert_eq!(again.attempts, MAX_WORK_ATTEMPTS);
        assert!(matches!(work_failed(&store_, &again, "boom").await.unwrap(), FailedWork::GaveUp { .. }));
    }
}
