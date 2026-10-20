//! Core slots: the host's own services, filled by a module
//! (docs/contracts/store-slot.md, limiter-slot.md, loop-guard-slot.md,
//! wake-slot.md). Each
//! slot's methods are those documents' tables, method for method, carried in
//! the adapter protocol's envelope like every other module's (`store.open`,
//! `runs.start`, …), with a slot's results as its table gives them.
//!
//! A fenced store write that finds the run's lease gone fails with
//! [`ModuleError::run_lease_lost`].

use std::collections::BTreeMap;
use std::future::Future;

use module_wire::json::Js;
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};

use crate::context::{Answer, Ctx, ModuleError, from_js, to_js};
use crate::module::{LocalFuture, Module, manifest_frame};

/// The error code of a fenced write that found the run's lease gone: the
/// host treats it as losing the run.
pub const RUN_LEASE_LOST_CODE: &str = "run_lease_lost";

impl ModuleError {
    pub fn run_lease_lost(run_id: &str) -> ModuleError {
        ModuleError::new(RUN_LEASE_LOST_CODE, format!("run {run_id}'s lease is gone"))
            .with_data(Js::Obj(module_wire::obj! { "name" => Js::str("RunLeaseLost"), "runId" => Js::str(run_id) }))
    }
}

/// One slot: its params, its trait, and the module the host serves for it.
macro_rules! slot {
    (
        $(#[$doc:meta])*
        pub trait $Trait:ident served as $Served:ident in slot $slot:literal {
            $(
                $(#[$mdoc:meta])*
                $wire:literal => fn $method:ident($Params:ident { $( $(#[$fmeta:meta])* $field:ident : $fty:ty ),* $(,)? }) -> $Ret:ty;
            )*
        }
    ) => {
        $(
            #[derive(Debug, Clone, Deserialize)]
            #[serde(rename_all = "camelCase")]
            pub struct $Params { $( $(#[$fmeta])* pub $field: $fty, )* }
        )*

        $(#[$doc])*
        pub trait $Trait {
            $( $(#[$mdoc])* fn $method(&self, ctx: &Ctx, params: $Params) -> impl Future<Output = Answer<$Ret>>; )*
        }

        #[doc = concat!("A module filling the `", $slot, "` slot, as the host serves it.")]
        pub struct $Served<T> {
            name: String,
            module: T,
        }

        impl<T: $Trait> $Served<T> {
            pub fn new(name: impl Into<String>, module: T) -> $Served<T> {
                $Served { name: name.into(), module }
            }

            async fn answer(&self, ctx: &Ctx, method: &str, params: Js) -> Answer<Js> {
                match method {
                    $( $wire => to_js(&self.module.$method(ctx, from_js(method, &params)?).await?), )*
                    unknown => Err(ModuleError::not_implemented(unknown)),
                }
            }
        }

        impl<T: $Trait> Module for $Served<T> {
            fn manifest(&self) -> Js {
                let methods = [$( $wire.to_string() ),*];
                manifest_frame("core", &self.name, &[], &methods, &module_wire::obj! { "slot" => Js::str($slot) })
            }

            fn call<'a>(&'a self, ctx: &'a Ctx, method: &'a str, params: Js) -> LocalFuture<'a, Answer<Js>> {
                Box::pin(self.answer(ctx, method, params))
            }
        }
    };
}

// ── store ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Opened {
    /// The team id the host's own runs are kept under.
    pub tenant: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub file: String,
    pub movement: String,
    pub status: String,
    pub started_at: String,
    pub input: String,
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CancelRequest {
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaimedLeaf {
    pub reason: String,
    pub state: Js,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeafRow {
    pub address: String,
    pub reason: String,
    pub status: String,
    pub wake_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JoinClosed {
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchExport {
    pub branch_address: String,
    pub branch_index: i64,
    pub exports: Js,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Correlated {
    pub run_id: String,
    pub team_id: String,
    pub address: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCorrelation {
    pub run_id: String,
    pub team_id: String,
    pub address: String,
    pub correlation_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Lease {
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaimedWork {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub payload: Js,
    pub claim: String,
    /// The row's claims since it last succeeded, this one included, less
    /// those released as `busy`.
    pub attempts: i64,
}

/// One park's kind and what wakes it (`parks.commit`'s `park`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ParkKind {
    /// Arms the run's `resume_timer` row at `wake_at` (an earlier due time kept).
    #[serde(rename_all = "camelCase")]
    Timer { wake_at: String },
    /// Kept with its correlation.
    #[serde(rename_all = "camelCase")]
    Await { team_id: String, adapter_type: String, correlation_key: String },
    /// Drops the address's correlation.
    Limit,
}

/// What a `work.release` says of the claim.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseWhy {
    /// The work failed: the claim was an attempt.
    #[default]
    Failed,
    /// The row's run was held elsewhere: the attempt is given back.
    Busy,
    /// The work was done and is due again: the attempts start over.
    Rescheduled,
}

/// A work row to queue, as `work.enqueue` takes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWork {
    pub kind: String,
    pub key: String,
    pub payload: Js,
    pub due_at: Option<String>,
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Minted {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackRow {
    pub id: String,
    pub team_id: String,
    pub run_id: String,
    pub address: String,
    pub params: Js,
    pub state: Js,
    pub calls: Js,
    pub single_use: bool,
    pub expires_at: Option<String>,
    /// `live`, `fired` or `revoked`.
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CallbackRecorded {
    Recorded {
        callback: CallbackRow,
        #[serde(rename = "callIndex")]
        call_index: i64,
    },
    NotFound,
    Closed {
        callback: CallbackRow,
    },
    Expired {
        callback: CallbackRow,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct Checkpoint {
    pub checkpoint: Js,
}

/// The module processes the hosts on this store started, at the version a
/// `processes.swap` writes over (0: never written).
#[derive(Debug, Clone, Serialize)]
pub struct ModuleProcesses {
    pub processes: Js,
    pub version: i64,
}

slot! {
    /// The store slot: a host's run state (runs, parks, joins, await
    /// correlations, leases, the work queue, library sources, callbacks,
    /// pull cursors and event receipts). The meaning of each method is the
    /// run host's contract suite's.
    pub trait Store served as StoreModule in slot "store" {
        /// Always the first request.
        "store.open" => fn open(StoreOpen { #[serde(default)] settings: BTreeMap<String, String> }) -> Opened;
        "runs.start" => fn start_run(RunsStart { id: String, file: String, movement: String, started_at: String, input: String }) -> ();
        /// `runs.start` and `events.claim` as one write: `false`, and no run,
        /// for an event the listen has run before.
        "events.startRun" => fn start_event_run(EventsStartRun { listen: String, key: String, id: String, file: String, movement: String, started_at: String, input: String }) -> bool;
        /// Runs still `running` whose lease lapsed or was never taken,
        /// started more than `stale_ms` ago; oldest first.
        "runs.lapsed" => fn lapsed_runs(RunsLapsed { stale_ms: i64, limit: i64 }) -> Vec<String>;
        /// `status`: `completed`, `parked`, `running` or `failed`; an ending
        /// revokes the run's live callbacks.
        "runs.settle" => fn settle_run(RunsSettle { run_id: String, status: String, outcome: Js, at: String }) -> ();
        "runs.markParked" => fn mark_parked(RunsMarkParked { run_id: String }) -> ();
        "runs.get" => fn run(RunsGet { run_id: String }) -> Option<RunRow>;
        /// Most recent first.
        "runs.list" => fn runs(RunsList { limit: i64 }) -> Vec<RunRow>;
        "runs.appendTrace" => fn append_trace(RunsAppendTrace { run_id: String, segment_id: String, entries: Vec<Js> }) -> ();
        "runs.traceLength" => fn trace_length(RunsTraceLength { run_id: String }) -> i64;
        /// Microdollars spent since the spend baseline.
        "runs.spent" => fn spent(RunsSpent { run_id: String }) -> f64;
        "runs.addSpend" => fn add_spend(RunsAddSpend { run_id: String, microdollars: f64 }) -> ();
        "runs.resetSpendBaseline" => fn reset_spend_baseline(RunsResetSpendBaseline { run_id: String }) -> ();
        "runs.requestCancel" => fn request_cancel(RunsRequestCancel { run_id: String, reason: Option<String> }) -> ();
        /// `None` when no cancel was asked.
        "records.cancelRequest" => fn cancel_request(RecordsCancelRequest { run_id: String }) -> Option<CancelRequest>;
        "records.markFailed" => fn mark_failed(RecordsMarkFailed { run_id: String, message: String }) -> ();
        "parks.putLeaf" => fn put_leaf(ParksPutLeaf { run_id: String, address: String, reason: String, wake_at: Option<String>, state: Js, fence: Option<String> }) -> ();
        "parks.claimLeaf" => fn claim_leaf(ParksClaimLeaf { run_id: String, address: String, reason: Option<String> }) -> Option<ClaimedLeaf>;
        "parks.finishLeaf" => fn finish_leaf(ParksFinishLeaf { run_id: String, address: String, fence: Option<String> }) -> ();
        "parks.leaves" => fn leaves(ParksLeaves { run_id: String, parked_only: bool, reason: Option<String>, due_by: Option<String> }) -> Vec<LeafRow>;
        "parks.deleteLeaves" => fn delete_leaves(ParksDeleteLeaves { run_id: String, addresses: Vec<String> }) -> ();
        /// One fenced write: the leaf, its kind's row, the run marked parked.
        "parks.commit" => fn commit_park(ParksCommit { run_id: String, address: String, state: Js, fence: Option<String>, park: ParkKind }) -> ();
        "joins.recordJoin" => fn record_join(JoinsRecordJoin { run_id: String, frame_address: String, pending: i64, fence: Option<String> }) -> ();
        "joins.decrementJoin" => fn decrement_join(JoinsDecrementJoin { run_id: String, frame_address: String, branch_address: String, leaf_address: String }) -> JoinClosed;
        "joins.persistBranchExport" => fn persist_branch_export(JoinsPersistBranchExport { run_id: String, frame_address: String, branch_address: String, branch_index: i64, exports: Js }) -> ();
        "joins.collectBranchExports" => fn collect_branch_exports(JoinsCollectBranchExports { run_id: String, frame_address: String }) -> Vec<BranchExport>;
        "joins.hasPendingJoins" => fn has_pending_joins(JoinsHasPendingJoins { run_id: String }) -> bool;
        "joins.frames" => fn frames(JoinsFrames { run_id: String }) -> Vec<String>;
        "joins.deleteFrames" => fn delete_frames(JoinsDeleteFrames { run_id: String, frame_addresses: Vec<String> }) -> ();
        "correlations.correlate" => fn correlate(CorrelationsCorrelate { run_id: String, team_id: String, address: String, adapter_type: String, correlation_key: String }) -> ();
        "correlations.correlated" => fn correlated(CorrelationsCorrelated { adapter_type: String, team_id: String, correlation_key: String }) -> Vec<Correlated>;
        "correlations.ofRun" => fn correlations_of_run(CorrelationsOfRun { run_id: String, adapter_type: String }) -> Vec<RunCorrelation>;
        "correlations.drop" => fn drop_correlation(CorrelationsDrop { run_id: String, address: String }) -> ();
        "correlations.dropRun" => fn drop_run_correlations(CorrelationsDropRun { run_id: String }) -> ();
        /// `None` while another holds it.
        "leases.claim" => fn claim_lease(LeasesClaim { run_id: String, ttl_ms: i64 }) -> Option<Lease>;
        "leases.renew" => fn renew_lease(LeasesRenew { run_id: String, token: String, ttl_ms: i64 }) -> bool;
        "leases.release" => fn release_lease(LeasesRelease { run_id: String, token: String }) -> ();
        "leases.dropRunState" => fn drop_run_state(LeasesDropRunState { run_id: String, fence: Option<String> }) -> bool;
        "work.enqueue" => fn enqueue(WorkEnqueue { kind: String, key: String, payload: Js, due_at: Option<String>, team_id: Option<String> }) -> ();
        /// `kinds` (a drain pool's) leases only rows of those kinds; absent, every kind.
        "work.claimDue" => fn claim_due(WorkClaimDue { limit: i64, lease_ms: i64, due_by: Option<String>, kinds: Option<Vec<String>> }) -> Vec<ClaimedWork>;
        "work.complete" => fn complete_work(WorkComplete { id: String, claim: String }) -> ();
        /// `why` absent is `failed`.
        "work.release" => fn release_work(WorkRelease { id: String, claim: String, due_at: Option<String>, #[serde(default)] why: ReleaseWhy }) -> ();
        /// Never claimed again, kept with `reason`, unless re-armed since the claim.
        "work.bury" => fn bury_work(WorkBury { id: String, claim: String, reason: String }) -> ();
        "sources.put" => fn put_source(SourcesPut { team_id: String, hash: String, source: String }) -> ();
        "sources.get" => fn source(SourcesGet { team_id: String, hash: String }) -> Option<String>;
        "callbacks.mint" => fn mint_callback(CallbacksMint { team_id: String, run_id: String, address: String, params: Js, state: Js, single_use: bool, expires_at: Option<String> }) -> Minted;
        "callbacks.get" => fn callback(CallbacksGet { id: String }) -> Option<CallbackRow>;
        "callbacks.record" => fn record_callback(CallbacksRecord { id: String, values: Js, body_due_at: String }) -> CallbackRecorded;
        "callbacks.markBodyStarted" => fn mark_callback_body_started(CallbacksMarkBodyStarted { id: String, call_index: i64, fence: Option<String> }) -> bool;
        /// Those of `ids` with at least one call whose body started.
        "callbacks.landed" => fn landed_callbacks(CallbacksLanded { ids: Vec<String> }) -> Vec<String>;
        "callbacks.revokeRun" => fn revoke_run_callbacks(CallbacksRevokeRun { run_id: String }) -> ();
        "inbound.checkpoint" => fn inbound_checkpoint(InboundCheckpoint { subscription_id: String }) -> Option<Checkpoint>;
        "inbound.saveCheckpoint" => fn save_inbound_checkpoint(InboundSaveCheckpoint { subscription_id: String, checkpoint: Js }) -> ();
        /// One write: the cursor (absent: left as it is) and the work rows.
        "inbound.keepDelivery" => fn keep_delivery(InboundKeepDelivery { subscription_id: String, #[serde(default, deserialize_with = "present")] checkpoint: Option<Js>, work: Vec<NewWork> }) -> ();
        /// The module processes the hosts on this store started (so the next
        /// stops what a killed one left), with the list's version.
        "processes.list" => fn module_processes(ProcessesList {}) -> ModuleProcesses;
        /// Write `processes` only if the list is still at `version` (it moves
        /// to `version + 1`); `true` when it wrote.
        "processes.swap" => fn swap_module_processes(ProcessesSwap { version: i64, processes: Js }) -> bool;
        /// `true` the first time this event key reaches this listen; `false`
        /// for a redelivery, which runs nothing.
        "events.claim" => fn claim_event(EventsClaim { listen: String, key: String }) -> bool;
    }
}

/// A field that is present, even as `null`, is Some: `inbound.keepDelivery`'s
/// cursor is absent when it did not move, and may move to `null`.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Js>, D::Error> {
    Js::deserialize(deserializer).map(Some)
}

// ── limiter ──────────────────────────────────────────────────────────────────

/// One limit a call counts in: at most `calls` per `per_ms`, and at most
/// `concurrent` permits held at once, in the bucket `key` names (opaque).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub key: String,
    pub calls: Option<f64>,
    pub per_ms: Option<f64>,
    pub concurrent: Option<f64>,
}

/// An `acquire`'s answer. A refused call counts in no limit.
#[derive(Debug, Clone)]
pub enum Grant {
    Granted { permit: String },
    /// Ask again at this instant.
    Refused { retry_at: String },
}

impl Serialize for Grant {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        match self {
            Grant::Granted { permit } => {
                map.serialize_entry("granted", &true)?;
                map.serialize_entry("permit", permit)?;
            }
            Grant::Refused { retry_at } => {
                map.serialize_entry("granted", &false)?;
                map.serialize_entry("retryAt", retry_at)?;
            }
        }
        map.end()
    }
}

slot! {
    /// The limiter slot: keeps the host's calls to modules and models inside
    /// the providers' limits. No method waits; the host does the waiting.
    /// Every request carries its limits, so a limiter keeps no configuration.
    pub trait Limiter served as LimiterModule in slot "limiter" {
        "limiter.open" => fn open(LimiterOpen { #[serde(default)] settings: BTreeMap<String, String> }) -> ();
        /// Granted only when every limit has room and `key` is not throttled;
        /// then the call counts in all of them at once. A permit never
        /// released lapses after `hold_ms`.
        "limiter.acquire" => fn acquire(LimiterAcquire { key: String, cost: f64, limits: Vec<Limit>, hold_ms: i64 }) -> Grant;
        /// A permit released twice, or never given, changes nothing.
        "limiter.release" => fn release(LimiterRelease { permit: String }) -> ();
        /// No call on `key` before `until`.
        "limiter.throttle" => fn throttle(LimiterThrottle { key: String, until: String }) -> ();
    }
}

// ── wake ─────────────────────────────────────────────────────────────────────

slot! {
    /// The wake slot: the host saying work is due, so whatever starts its
    /// workers (a cloud queue, a scheduled task service) starts one then.
    /// Each method answers once the wake is arranged, not once the work ran.
    /// `kind` is the work row's kind (`fire_event`, `resume_timer`, …); a
    /// module may start a worker for that kind's pool, or ignore it.
    pub trait Wake served as WakeModule in slot "wake" {
        /// Start a worker soon. Many in a row may start one.
        "wake.now" => fn now(WakeNow { kind: String }) -> ();
        /// Start a worker at `at` (an instant, as `Date.toISOString` writes
        /// it), never before; one in the past is `now`. Refuse an `at` that
        /// is not an instant with `ModuleError::bad_request`.
        "wake.at" => fn at(WakeAt { kind: String, at: String }) -> ();
    }
}

// ── ocr ──────────────────────────────────────────────────────────────────────

/// One cost line of a read: what it spent, as the run's spend counts it.
#[derive(Debug, Clone, Serialize)]
pub struct OcrCost {
    pub label: String,
    pub microdollars: u64,
}

/// An `ocr.read`'s answer.
#[derive(Debug, Clone, Serialize)]
pub struct OcrRead {
    /// Every page's text, in page order; empty when the pages hold none.
    pub text: String,
    /// The pages read (an image is one).
    pub pages: u64,
    /// Required, and not zero for pages read unless the module is free:
    /// the host refuses a read its run's cost cap cannot count.
    pub cost: Vec<OcrCost>,
}

slot! {
    /// The ocr slot: a scanned PDF's or an image's bytes in, their text out.
    /// The host asks it of a file with no text layer of its own; a module
    /// asks it through the host (`Ctx::ocr`). Refuse bytes of a type the
    /// module does not read with the code `unsupported_type`. The optional
    /// `ocr.prices` (a price per page) is not part of this trait: a module
    /// publishing one serves it beside it.
    pub trait Ocr served as OcrModule in slot "ocr" {
        "ocr.read" => fn read(OcrReadRequest {
            #[serde(deserialize_with = "crate::host_ocr::base64_bytes")]
            bytes: Vec<u8>,
            content_type: String,
            #[serde(default)]
            name: Option<String>,
            label: String,
        }) -> OcrRead;
    }
}

// ── loop guard ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentRecord {
    pub record_type: String,
    pub record: Js,
}

/// An `isEcho`'s answer.
#[derive(Debug, Clone)]
pub enum Echo {
    Decided(bool),
    /// The guard needs the record as it stands: the host reads it and asks
    /// again with `current`.
    Read { record_type: String },
}

impl Serialize for Echo {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        match self {
            Echo::Decided(echo) => map.serialize_entry("echo", echo)?,
            Echo::Read { record_type } => {
                let read: BTreeMap<&str, &str> = BTreeMap::from([("recordType", record_type.as_str())]);
                map.serialize_entry("read", &read)?;
            }
        }
        map.end()
    }
}

slot! {
    /// The loop guard slot: tells a movement's own write coming back (an
    /// echo) from a real change. Any doubt means the event fires.
    pub trait LoopGuard served as LoopGuardModule in slot "loopGuard" {
        "guard.open" => fn open(GuardOpen { #[serde(default)] settings: BTreeMap<String, String> }) -> ();
        /// `writer` (`listen:<file>:<movement>`) wrote `external_id`; `record`
        /// is the source's answer read back right after (`null`: gone).
        "guard.recordWrite" => fn record_write(GuardRecordWrite { adapter: String, record_type: String, external_id: String, writer: String, record: Js }) -> ();
        "guard.isEcho" => fn is_echo(GuardIsEcho { adapter: String, external_id: String, writer: String, current: Option<CurrentRecord> }) -> Echo;
    }
}
