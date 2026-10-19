//! `lf --contract-store <state.db|postgres://…>`: the run host's backend
//! families (crate::backend) served as a store module: the store slot's
//! methods (docs/contracts/store-slot.md) as adapter protocol 2 calls over
//! HTTP on a Unix socket (crate::slot_server), so the TypeScript contract
//! suite drives this store through its `RpcStoreBackend` (movement-engine
//! `services/run_host/rpc_store.ts`) and
//! holds it to the meaning every backend has. `--contract-store-slot` serves
//! the project's store slot instead, a store module's process included.
//!
//! A method is `<family>.<method>` as `RunHostStore` names it
//! (`parks.putLeaf`, `work.claimDue`, …), its params the TypeScript method's
//! one input object, its result the TypeScript method's answer (`null` for
//! none). The callback family is `callbacks.<method>` as `CallbackStore`
//! names it, and the run records `records.<method>` as `RunRecords` does.
//! `runs.start` adds a run row, the contract's `newRun`; `runs.requestCancel`,
//! `runs.status` and `runs.complete` are the records backend's
//! `requestCancel`, `runStatus` and `completeRun`. A fenced write
//! refused because the lease is gone answers the error code
//! `run_lease_lost` (`data: { runId }`), which the client rethrows as the
//! core's `RunLeaseLost`. Requests are answered one at a time.
//! The callback family and the run records (`callbacks.*`, `runs.*`) are
//! crate::callbacks's.

use crate::backend::{MintCallback, RunHostStore, StoreSpec, open_store};
use crate::json::Js;
use crate::obj;
use crate::slot_server::{Listen, Refusal};
use crate::store::{ClaimDue, StoreError, iso};
use crate::store_wire::{Wire, num, opt, to_rows};

/// The store slot's methods (docs/contracts/store-slot.md), as its manifest lists them.
pub const STORE_METHODS: &[&str] = &[
    "store.open", "runs.start", "runs.requestCancel", "runs.status", "runs.complete", "runs.settle", "runs.markParked", "runs.get",
    "runs.list", "runs.appendTrace", "runs.traceLength", "runs.spent", "runs.addSpend", "runs.resetSpendBaseline", "records.cancelRequest",
    "records.markFailed", "records.closeRun", "callbacks.mint", "callbacks.get", "callbacks.record", "callbacks.markBodyStarted",
    "callbacks.landed", "callbacks.revokeRun", "parks.putLeaf", "parks.claimLeaf", "parks.finishLeaf", "parks.leaves", "parks.deleteLeaves",
    "joins.recordJoin", "joins.decrementJoin", "joins.persistBranchExport", "joins.collectBranchExports", "joins.hasPendingJoins",
    "joins.frames", "joins.deleteFrames", "correlations.correlate", "correlations.correlated", "correlations.ofRun", "correlations.drop",
    "correlations.dropRun", "leases.claim", "leases.renew", "leases.release", "leases.dropRunState", "work.enqueue", "work.claimDue",
    "work.complete", "work.release", "sources.put", "sources.get", "inbound.checkpoint", "inbound.saveCheckpoint", "processes.list",
    "processes.swap", "events.claim",
];

pub async fn serve(spec: &StoreSpec, listen: Listen) -> Result<(), String> {
    // The bridge stands in for a set-up store: a Postgres one's setup
    // (`lf connect @lf/postgres-store`) is run first.
    #[cfg(feature = "postgres")]
    if let StoreSpec::Postgres { url, .. } = spec {
        crate::pg_store::PgStore::migrate(url).map_err(|e| format!("{}: {e}", spec.display()))?;
    }
    let store = open_store(spec)?;
    let manifest = crate::slot_server::manifest("@lf/contract-store", "store", STORE_METHODS);
    crate::slot_server::serve(listen, manifest, move |method, params, _settings| answer(&*store, method, params)).await
}

fn answer(store: &dyn RunHostStore, method: &str, params: &Js) -> Result<Js, Refusal> {
    match dispatch(store, method, &Params(params)) {
        Ok(result) => Ok(result),
        Err(Failure::Store(StoreError::LeaseLost { run_id })) => Err(Refusal {
            code: crate::store_module::LEASE_LOST.into(),
            message: "run lease lost; another instance may hold the run".into(),
            data: Some(Js::from(obj! { "runId" => Js::str(run_id) })),
        }),
        Err(Failure::Store(other)) => Err(Refusal::failed(describe(&other))),
        Err(Failure::Params(message)) => Err(Refusal::bad_request(format!("{method}: {message}"))),
        Err(Failure::Unknown) => Err(Refusal::unknown(method)),
    }
}

fn describe(error: &StoreError) -> String {
    match error {
        StoreError::LeaseLost { run_id } => format!("run lease lost: {run_id}"),
        StoreError::Invalid(message) => message.clone(),
        StoreError::Db(error) => error.to_string(),
        StoreError::Backend(message) => message.clone(),
    }
}

enum Failure {
    Store(StoreError),
    Params(String),
    Unknown,
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Failure::Store(error)
    }
}

/// One request's input object.
struct Params<'a>(&'a Js);

impl Params<'_> {
    fn str(&self, key: &str) -> Result<&str, Failure> {
        self.0.get(key).and_then(Js::as_str).ok_or_else(|| Failure::Params(format!("{key}: expected a string")))
    }

    /// An optional string; `null` reads as absent.
    fn opt_str(&self, key: &str) -> Result<Option<&str>, Failure> {
        match self.0.get(key) {
            None | Some(Js::Null) => Ok(None),
            Some(Js::Str(s)) => Ok(Some(s)),
            Some(_) => Err(Failure::Params(format!("{key}: expected a string"))),
        }
    }

    /// An optional list of strings; `null` reads as absent.
    fn opt_strings(&self, key: &str) -> Result<Option<Vec<String>>, Failure> {
        match self.0.get(key) {
            None | Some(Js::Null) => Ok(None),
            Some(Js::Arr(items)) => items.iter().map(|i| i.as_str().map(str::to_string)).collect::<Option<Vec<_>>>().map(Some).ok_or_else(|| Failure::Params(format!("{key}: expected a list of strings"))),
            Some(_) => Err(Failure::Params(format!("{key}: expected a list of strings"))),
        }
    }

    fn int(&self, key: &str) -> Result<i64, Failure> {
        self.0.get(key).and_then(crate::store_wire::int).ok_or_else(|| Failure::Params(format!("{key}: expected an integer")))
    }

    fn number(&self, key: &str) -> Result<f64, Failure> {
        match self.0.get(key) {
            Some(Js::Num(n)) => n.as_f64(),
            _ => None,
        }
        .ok_or_else(|| Failure::Params(format!("{key}: expected a number")))
    }

    fn flag(&self, key: &str) -> bool {
        Js::is_true(self.0.get(key))
    }

    /// A JSON value; absent (`undefined`) is stored as `null`, as `x ?? null`.
    fn value(&self, key: &str) -> Js {
        self.0.get(key).cloned().unwrap_or(Js::Null)
    }

    fn strings(&self, key: &str) -> Result<Vec<String>, Failure> {
        self.0
            .get(key)
            .and_then(Js::as_array)
            .and_then(|items| items.iter().map(|i| i.as_str().map(str::to_string)).collect::<Option<Vec<_>>>())
            .ok_or_else(|| Failure::Params(format!("{key}: expected an array of strings")))
    }
}

fn dispatch(store: &dyn RunHostStore, method: &str, p: &Params) -> Result<Js, Failure> {
    let none = Ok(Js::Null);
    match method {
        // The store wire's opening request: a store module reads its
        // settings from it; this bridge's store is named on its command line.
        "store.open" => Ok(Js::from(obj! { "tenant" => Js::str(store.tenant()) })),

        "runs.start" => {
            store.start_run(p.str("id")?, p.str("file")?, p.str("movement")?, p.str("startedAt")?, p.str("input")?)?;
            none
        }
        "runs.requestCancel" => {
            store.request_cancel(p.str("runId")?, p.opt_str("reason")?)?;
            none
        }
        "runs.status" => Ok(store.run(p.str("runId")?)?.map(|r| Js::str(r.status)).unwrap_or(Js::str("missing"))),
        "runs.complete" => {
            store.settle_run(p.str("runId")?, "completed", &Js::Null, &iso(0))?;
            none
        }
        "runs.settle" => {
            store.settle_run(p.str("runId")?, p.str("status")?, &p.value("outcome"), p.str("at")?)?;
            none
        }
        "runs.markParked" => {
            store.mark_parked(p.str("runId")?)?;
            none
        }
        "runs.get" => Ok(store.run(p.str("runId")?)?.as_ref().map(Wire::to_wire).unwrap_or(Js::Null)),
        "runs.list" => Ok(to_rows(&store.runs(p.int("limit")?)?)),
        "runs.appendTrace" => {
            let entries = p.value("entries");
            let entries = entries.as_array().ok_or_else(|| Failure::Params("entries: expected an array".into()))?;
            store.append_trace(p.str("runId")?, p.str("segmentId")?, entries)?;
            none
        }
        "runs.traceLength" => Ok(Js::Num(store.trace_len(p.str("runId")?)?.into())),
        "runs.spent" => Ok(num(store.run_spent(p.str("runId")?)?)),
        "runs.addSpend" => {
            store.add_run_spend(p.str("runId")?, p.number("microdollars")?)?;
            none
        }
        "runs.resetSpendBaseline" => {
            store.reset_spend_baseline(p.str("runId")?)?;
            none
        }

        "records.cancelRequest" => Ok(match store.cancel_request(p.str("runId")?)? {
            None => Js::Null,
            Some(reason) => Js::from(obj! { "reason" => opt(reason.as_deref()) }),
        }),
        "records.markFailed" => {
            store.mark_failed(p.str("runId")?, p.str("message")?)?;
            none
        }
        "records.closeRun" => {
            store.revoke_run_callbacks(p.str("runId")?)?;
            none
        }

        "callbacks.mint" => {
            let (params, state) = (p.value("params"), p.value("state"));
            let id = store.mint_callback(MintCallback {
                team_id: p.str("teamId")?,
                run_id: p.str("runId")?,
                address: p.str("address")?,
                params: &params,
                state: &state,
                single_use: p.flag("singleUse"),
                expires_at: p.opt_str("expiresAt")?,
            })?;
            Ok(Js::from(obj! { "id" => Js::str(id) }))
        }
        "callbacks.get" => Ok(store.callback(p.str("id")?)?.as_ref().map(Wire::to_wire).unwrap_or(Js::Null)),
        "callbacks.record" => Ok(store.record_callback_call(p.str("id")?, &p.value("values"), p.str("bodyDueAt")?)?.to_wire()),
        "callbacks.markBodyStarted" => Ok(Js::Bool(store.mark_callback_body_started(p.str("id")?, p.int("callIndex")?, p.opt_str("fence")?)?)),
        "callbacks.landed" => Ok(Js::strings(store.landed_callbacks(&p.strings("ids")?)?)),
        "callbacks.revokeRun" => {
            store.revoke_run_callbacks(p.str("runId")?)?;
            none
        }

        "parks.putLeaf" => {
            store.put_leaf(p.str("runId")?, p.str("address")?, p.str("reason")?, p.opt_str("wakeAt")?, &p.value("state"), p.opt_str("fence")?)?;
            none
        }
        "parks.claimLeaf" => Ok(match store.claim_leaf(p.str("runId")?, p.str("address")?, p.opt_str("reason")?)? {
            None => Js::Null,
            Some((reason, state)) => Js::from(obj! { "reason" => Js::str(reason), "state" => state }),
        }),
        "parks.finishLeaf" => {
            store.finish_leaf(p.str("runId")?, p.str("address")?, p.opt_str("fence")?)?;
            none
        }
        "parks.leaves" => Ok(to_rows(&store.leaves(p.str("runId")?, p.flag("parkedOnly"), p.opt_str("reason")?, p.opt_str("dueBy")?)?)),
        "parks.deleteLeaves" => {
            store.delete_leaves(p.str("runId")?, &p.strings("addresses")?)?;
            none
        }

        "joins.recordJoin" => {
            store.record_join(p.str("runId")?, p.str("frameAddress")?, p.int("pending")?, p.opt_str("fence")?)?;
            none
        }
        "joins.decrementJoin" => {
            let closed = store.decrement_join(p.str("runId")?, p.str("frameAddress")?, p.str("branchAddress")?, p.str("leafAddress")?)?;
            Ok(Js::from(obj! { "closed" => Js::Bool(closed) }))
        }
        "joins.persistBranchExport" => {
            store.persist_branch_export(p.str("runId")?, p.str("frameAddress")?, p.str("branchAddress")?, p.int("branchIndex")?, &p.value("exports"))?;
            none
        }
        "joins.collectBranchExports" => Ok(to_rows(&store.collect_branch_exports(p.str("runId")?, p.str("frameAddress")?)?)),
        "joins.hasPendingJoins" => Ok(Js::Bool(store.has_pending_joins(p.str("runId")?)?)),
        "joins.frames" => Ok(Js::strings(store.frames(p.str("runId")?)?)),
        "joins.deleteFrames" => {
            store.delete_frames(p.str("runId")?, &p.strings("frameAddresses")?)?;
            none
        }

        "correlations.correlate" => {
            store.correlate(p.str("runId")?, p.str("teamId")?, p.str("address")?, p.str("adapterType")?, p.str("correlationKey")?)?;
            none
        }
        "correlations.correlated" => Ok(to_rows(&store.correlated(p.str("adapterType")?, p.str("teamId")?, p.str("correlationKey")?)?)),
        "correlations.ofRun" => Ok(to_rows(&store.of_run(p.str("runId")?, p.str("adapterType")?)?)),
        "correlations.drop" => {
            store.drop_correlation(p.str("runId")?, p.str("address")?)?;
            none
        }
        "correlations.dropRun" => {
            store.drop_run_correlations(p.str("runId")?)?;
            none
        }

        "leases.claim" => Ok(match store.claim_lease(p.str("runId")?, p.int("ttlMs")?)? {
            None => Js::Null,
            Some(token) => Js::from(obj! { "token" => Js::str(token) }),
        }),
        "leases.renew" => Ok(Js::Bool(store.renew_lease(p.str("runId")?, p.str("token")?, p.int("ttlMs")?)?)),
        "leases.release" => {
            store.release_lease(p.str("runId")?, p.str("token")?)?;
            none
        }
        "leases.dropRunState" => Ok(Js::Bool(store.drop_run_state(p.str("runId")?, p.opt_str("fence")?)?)),

        "work.enqueue" => {
            store.enqueue(p.str("kind")?, p.str("key")?, &p.value("payload"), p.opt_str("dueAt")?, p.opt_str("teamId")?)?;
            none
        }
        "work.claimDue" => {
            let kinds = p.opt_strings("kinds")?;
            let claim = ClaimDue { limit: p.int("limit")?, lease_ms: p.int("leaseMs")?, due_by: p.opt_str("dueBy")?, kinds: kinds.as_deref() };
            Ok(to_rows(&store.claim_due(&claim)?))
        }
        "work.complete" => {
            store.complete(p.str("id")?, p.str("claim")?)?;
            none
        }
        "work.release" => {
            store.release_work(p.str("id")?, p.str("claim")?, p.opt_str("dueAt")?)?;
            none
        }

        "sources.put" => {
            store.put_source(p.str("teamId")?, p.str("hash")?, p.str("source")?)?;
            none
        }
        "sources.get" => Ok(opt(store.get_source(p.str("teamId")?, p.str("hash")?)?.as_deref())),

        "inbound.checkpoint" => Ok(match store.inbound_checkpoint(p.str("subscriptionId")?)? {
            None => Js::Null,
            Some(checkpoint) => Js::from(obj! { "checkpoint" => checkpoint }),
        }),
        "inbound.saveCheckpoint" => {
            store.save_inbound_checkpoint(p.str("subscriptionId")?, &p.value("checkpoint"))?;
            none
        }

        "processes.list" => {
            let list = store.module_processes()?;
            Ok(Js::from(obj! { "processes" => list.processes, "version" => Js::Num(list.version.into()) }))
        }
        "processes.swap" => Ok(Js::Bool(store.swap_module_processes(p.int("version")?, &p.value("processes"))?)),

        "events.claim" => Ok(Js::Bool(store.claim_event(p.str("listen")?, p.str("key")?)?)),

        _ => Err(Failure::Unknown),
    }
}
