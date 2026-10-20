//! The run host's backend families (movement-engine
//! `services/run_host/store.ts`) over SQLite, in the state file
//! `.lf/state.db` (@lf/sqlite-store, the store slot's default). Held to the hosted
//! Postgres backend's meaning by the run host's contract suite, which drives
//! this store through `--contract-store` (crate::contract_store).
//!
//! Instants are text in `Date.toISOString`'s form, compared as text: that
//! form sorts as the instants do.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::json::Js;

/// The state file's tables, created when missing on every open.
pub const SCHEMA: &str = "
create table if not exists run (
  id text primary key,
  file text not null,
  movement text not null,
  status text not null,
  started_at text not null,
  finished_at text,
  input text not null,
  outcome text,
  lease_token text,
  lease_until text
);
create table if not exists trace (
  run_id text not null,
  seq integer not null,
  entry text not null,
  primary key (run_id, seq)
);
create table if not exists leaf (
  run_id text not null,
  address text not null,
  reason text not null,
  status text not null default 'parked',
  wake_at text,
  state text not null,
  primary key (run_id, address)
);
create table if not exists await_correlation (
  run_id text not null,
  team_id text not null,
  address text not null,
  adapter_type text not null,
  correlation_key text not null,
  primary key (run_id, address)
);
create index if not exists await_correlation_key on await_correlation (team_id, adapter_type, correlation_key);
create table if not exists join_frame (
  run_id text not null,
  frame_address text not null,
  pending integer not null,
  closed_by_address text,
  primary key (run_id, frame_address)
);
create table if not exists join_branch_export (
  run_id text not null,
  frame_address text not null,
  branch_address text not null,
  branch_index integer not null,
  exports text not null,
  decremented integer not null default 0,
  primary key (run_id, frame_address, branch_address)
);
create table if not exists record_binding (
  a_adapter_type text not null,
  a_instance_key text not null,
  a_type_id text not null,
  a_record_id text not null,
  b_adapter_type text not null,
  b_instance_key text not null,
  b_type_id text not null,
  b_record_id text not null,
  bound_seq integer not null,
  primary key (a_adapter_type, a_instance_key, a_type_id, a_record_id, b_adapter_type, b_instance_key, b_type_id, b_record_id)
);
create table if not exists park_library_source (
  team_id text not null,
  hash text not null,
  source text not null,
  primary key (team_id, hash)
);
create table if not exists callback (
  id text primary key,
  team_id text not null,
  run_id text not null,
  address text not null,
  params text not null,
  state text not null,
  calls text not null,
  single_use integer not null,
  expires_at text,
  status text not null,
  created_at text not null,
  fired_at text,
  revoked_at text
);
create index if not exists callback_run on callback (run_id);
create table if not exists inbound_checkpoint (
  subscription_id text primary key,
  checkpoint text not null
);
create table if not exists module_processes (
  id integer primary key check (id = 1),
  processes text not null,
  version integer not null
);
create table if not exists event_receipt (
  listen text not null,
  key text not null,
  received_at text not null,
  primary key (listen, key)
);
create table if not exists work (
  id integer primary key autoincrement,
  kind text not null,
  key text not null unique,
  payload text not null,
  due_at text not null,
  lease_token text,
  lease_until text,
  version integer not null default 0,
  attempts integer not null default 0,
  dead_at text,
  dead_reason text
);
";

/// The core's park reasons (`CORE_PARK_REASONS`).
pub const CORE_PARK_REASONS: &[&str] = &["timer", "await", "limit"];
/// A polled listen's row in the work queue: its next poll.
pub const POLL_WORK_KIND: &str = "poll_listen";
/// The work kinds lf queues.
pub const WORK_KINDS: &[&str] = &["resume_timer", "wake_await", "fire_event", "fire_callback", "poll_listen"];

/// Columns a state file written by an earlier lf lacks, added on open.
const ADDED_RUN_COLUMNS: &[&str] = &["cancel_requested_at", "cancel_reason"];
const ADDED_WORK_COLUMNS: &[(&str, &str)] = &[("attempts", "integer not null default 0"), ("dead_at", "text"), ("dead_reason", "text")];

#[derive(Debug)]
pub enum StoreError {
    /// `RunLeaseLost`: a fenced write under a token that no longer holds the run.
    LeaseLost { run_id: String },
    /// A value outside what the families take.
    Invalid(String),
    Db(rusqlite::Error),
    /// Another backend's failure (crate::pg_store), in its own words.
    Backend(String),
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Db(error)
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // `RunLeaseLost`'s words.
            StoreError::LeaseLost { .. } => f.write_str("run lease lost; another instance may hold the run"),
            StoreError::Invalid(message) => f.write_str(message),
            StoreError::Db(error) => write!(f, "{error}"),
            StoreError::Backend(message) => f.write_str(message),
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// A run's row, as far as the host reads it.
pub struct RunRow {
    pub id: String,
    pub file: String,
    pub movement: String,
    pub status: String,
    pub started_at: String,
    /// The run's facts a resume needs, as JSON.
    pub input: String,
    pub outcome: Option<String>,
}

fn run_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        id: r.get(0)?,
        file: r.get(1)?,
        movement: r.get(2)?,
        status: r.get(3)?,
        started_at: r.get(4)?,
        input: r.get(5)?,
        outcome: r.get(6)?,
    })
}

pub struct LeafRow {
    pub address: String,
    pub reason: String,
    pub status: String,
    pub wake_at: Option<String>,
}

/// One claim of due work rows (`work.claimDue`).
pub struct ClaimDue<'a> {
    pub limit: i64,
    pub lease_ms: i64,
    /// None: now.
    pub due_by: Option<&'a str>,
    /// Only rows of these kinds (a drain pool's, `lf drain --kinds`); None:
    /// every kind lf drains.
    pub kinds: Option<&'a [String]>,
}

impl ClaimDue<'_> {
    /// The kinds the claim takes, each one lf drains.
    pub fn kinds(&self) -> Result<Vec<String>> {
        let Some(kinds) = self.kinds else { return Ok(WORK_KINDS.iter().map(|k| k.to_string()).collect()) };
        match kinds.iter().find(|k| !WORK_KINDS.contains(&k.as_str())) {
            Some(other) => Err(StoreError::Invalid(format!("not a work kind: {other} (the kinds: {})", WORK_KINDS.join(", ")))),
            None => Ok(kinds.to_vec()),
        }
    }
}

pub struct ClaimedWork {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub payload: Js,
    pub claim: String,
    /// The row's claims since it last succeeded, this one included, less
    /// those given back ([`Release::Busy`]): a claim whose worker died counts.
    pub attempts: i64,
}

/// What a claimed row's release says of the claim (`work.release`'s `why`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Release {
    /// The work failed: the claim was an attempt.
    Failed,
    /// The row's run was held elsewhere: the claim was no attempt.
    Busy,
    /// The work was done and is due again (a polled listen's next poll):
    /// its attempts start over.
    Rescheduled,
}

impl Release {
    pub fn wire(self) -> &'static str {
        match self {
            Release::Failed => "failed",
            Release::Busy => "busy",
            Release::Rescheduled => "rescheduled",
        }
    }

    /// Absent is `failed`: a release before `why` existed was a retry.
    pub fn of_wire(why: Option<&str>) -> Result<Release> {
        match why {
            None | Some("failed") => Ok(Release::Failed),
            Some("busy") => Ok(Release::Busy),
            Some("rescheduled") => Ok(Release::Rescheduled),
            Some(other) => Err(StoreError::Invalid(format!("not a release: {other} (failed, busy or rescheduled)"))),
        }
    }
}

/// A work row to queue, as `work.enqueue` takes it.
#[derive(Debug, Clone)]
pub struct NewWork {
    pub kind: String,
    pub key: String,
    pub payload: Js,
    /// None: now.
    pub due_at: Option<String>,
    /// None: the store's own tenant's row.
    pub team_id: Option<String>,
}

/// A run's `resume_timer` row: one per run, due at its earliest timer.
pub fn timer_work_key(run_id: &str) -> String {
    format!("resume_timer:{run_id}")
}

pub fn timer_work_payload(run_id: &str) -> Js {
    Js::Obj(crate::obj! { "runId" => Js::str(run_id) })
}

/// One park, kept as one with what wakes it (`parks.commit`): the leaf, the
/// kind's own row, and the run marked parked.
pub struct Park<'a> {
    pub run_id: &'a str,
    pub address: &'a str,
    pub state: &'a Js,
    /// The lease the write is fenced on; a lost one writes nothing.
    pub fence: Option<&'a str>,
    pub kind: ParkKind<'a>,
}

pub enum ParkKind<'a> {
    /// Woken by the run's `resume_timer` row, armed at `wake_at` (an earlier
    /// due time it already has is kept).
    Timer { wake_at: &'a str },
    /// Woken by a wake of its correlation, kept with it.
    Await { team_id: &'a str, adapter_type: &'a str, correlation_key: &'a str },
    /// Paused at a run limit: a correlation the address had is dropped.
    Limit,
}

impl ParkKind<'_> {
    pub fn reason(&self) -> &'static str {
        match self {
            ParkKind::Timer { .. } => "timer",
            ParkKind::Await { .. } => "await",
            ParkKind::Limit => "limit",
        }
    }
}

/// A new run's row (`runs.start`).
pub struct RunStart<'a> {
    pub id: &'a str,
    pub file: &'a str,
    pub movement: &'a str,
    pub started_at: &'a str,
    /// The run's facts a resume needs, as JSON.
    pub input: &'a str,
}

pub struct CorrelatedAwait {
    pub run_id: String,
    pub team_id: String,
    pub address: String,
}

pub struct BranchExport {
    pub branch_address: String,
    pub branch_index: i64,
    pub exports: Js,
}

/// `Date.prototype.toISOString` of now plus `offset_ms`.
pub fn iso(offset_ms: i64) -> String {
    iso_at(jiff::Timestamp::now().as_millisecond() + offset_ms)
}

/// The instant `at` (epoch milliseconds), as `iso` writes it.
pub fn iso_at(at: i64) -> String {
    let ts = jiff::Timestamp::from_millisecond(at).expect("an instant within range");
    format!("{}.{:03}Z", ts.strftime("%Y-%m-%dT%H:%M:%S"), at.rem_euclid(1000))
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn text_of(value: &Js) -> String {
    value.to_json()
}

fn parse_text(text: &str) -> Result<Js> {
    Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored value is not JSON: {e}")))
}

fn reason_of(reason: String) -> Result<String> {
    if CORE_PARK_REASONS.contains(&reason.as_str()) { Ok(reason) } else { Err(StoreError::Invalid(format!("not a park reason: {reason}"))) }
}

/// A work claim's handle (`<lease token>/<version>`).
fn work_claim(claim: &str) -> Result<(String, i64)> {
    let not = || StoreError::Invalid(format!("not a work claim: {claim}"));
    let at = claim.rfind('/').filter(|at| *at > 0).ok_or_else(not)?;
    let version = claim[at + 1..].parse::<i64>().map_err(|_| not())?;
    Ok((claim[..at].to_string(), version))
}

pub struct Store {
    pub(crate) db: Connection,
}

/// What a run has spent, and what it had spent when last resumed from its
/// cost cap, in microdollars (the cost cap reads the difference).
const SPEND_COLUMNS: &[&str] = &["spent_microdollars", "cost_cap_baseline_microdollars"];

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let db = Connection::open(path)?;
        // Two processes may share the file: readers never block the writer,
        // and a writer waits for another's transaction.
        db.execute_batch("pragma journal_mode = wal; pragma busy_timeout = 5000;")?;
        db.execute_batch(SCHEMA)?;
        let columns = db
            .prepare("select name from pragma_table_info('run')")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for column in ADDED_RUN_COLUMNS {
            if !columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table run add column {column} text"))?;
            }
        }
        // Added to a state file written before the cost cap kept run spend.
        for column in SPEND_COLUMNS {
            if !columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table run add column {column} real not null default 0"))?;
            }
        }
        // Added to a state file written before a failing row's retries were capped.
        let work_columns = db
            .prepare("select name from pragma_table_info('work')")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (column, declared) in ADDED_WORK_COLUMNS {
            if !work_columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table work add column {column} {declared}"))?;
            }
        }
        Ok(Store { db })
    }

    /// One write transaction, taken before its first read.
    pub(crate) fn transaction<T>(&self, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.db.execute_batch("begin immediate")?;
        match body(&self.db) {
            Ok(value) => {
                self.db.execute_batch("commit")?;
                Ok(value)
            }
            Err(error) => {
                self.db.execute_batch("rollback")?;
                Err(error)
            }
        }
    }

    /// Whether the run is leased under `fence`, and the lease has not lapsed.
    pub(crate) fn holds(db: &Connection, run_id: &str, fence: &str) -> Result<bool> {
        Ok(db
            .query_row("select 1 from run where id = ? and lease_token = ? and lease_until > ?", params![run_id, fence, iso(0)], |_| Ok(()))
            .optional()?
            .is_some())
    }

    fn fenced<T>(&self, run_id: &str, fence: Option<&str>, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Err(StoreError::LeaseLost { run_id: run_id.to_string() });
            }
            body(db)
        })
    }

    // ── Runs ────────────────────────────────────────────────────────────────

    pub fn start_run(&self, id: &str, file: &str, movement: &str, started_at: &str, input: &str) -> Result<()> {
        Self::start_run_in(&self.db, &RunStart { id, file, movement, started_at, input })
    }

    fn start_run_in(db: &Connection, run: &RunStart<'_>) -> Result<()> {
        db.execute(
            "insert into run (id, file, movement, status, started_at, input) values (?, ?, ?, ?, ?, ?)",
            params![run.id, run.file, run.movement, "running", run.started_at, run.input],
        )?;
        Ok(())
    }

    /// crate::backend::RunHostStore::start_event_run: the receipt and the
    /// run, or neither.
    pub fn start_event_run(&self, listen: &str, key: &str, run: &RunStart<'_>) -> Result<bool> {
        self.transaction(|db| {
            if !Self::claim_event_in(db, listen, key)? {
                return Ok(false);
            }
            Self::start_run_in(db, run)?;
            Ok(true)
        })
    }

    /// crate::backend::RunHostStore::lapsed_runs.
    pub fn lapsed_runs(&self, stale_ms: i64, limit: i64) -> Result<Vec<String>> {
        let now = iso(0);
        let mut statement = self.db.prepare(
            "select id from run
             where status = 'running' and (lease_until is null or lease_until < ?) and started_at < ?
             order by started_at limit ?",
        )?;
        Ok(statement.query_map(params![now, iso(-stale_ms), limit], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Record where the run stands. A run that ends, however it ends, revokes
    /// its live callbacks: a callback is something the run can still react to.
    pub fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()> {
        let ended = status == "completed" || status == "failed";
        self.transaction(|db| {
            db.execute(
                "update run set status = ?, outcome = ?, finished_at = ? where id = ?",
                params![status, text_of(outcome), ended.then_some(at), id],
            )?;
            if ended {
                Self::revoke_callbacks(db, id)?;
            }
            Ok(())
        })
    }

    /// The run is observably parked (a park landed). A settled run stays.
    pub fn mark_parked(&self, id: &str) -> Result<()> {
        Self::mark_parked_in(&self.db, id)
    }

    fn mark_parked_in(db: &Connection, id: &str) -> Result<()> {
        db.execute("update run set status = 'parked' where id = ? and status in ('running', 'parked')", params![id])?;
        Ok(())
    }

    /// The run is over without completing. A run already settled stays.
    pub fn mark_failed(&self, id: &str, message: &str) -> Result<()> {
        let outcome = Js::Obj(crate::obj! { "error" => Js::str(message) });
        self.transaction(|db| {
            db.execute(
                "update run set status = 'failed', outcome = ?, finished_at = ? where id = ? and status in ('running', 'parked')",
                params![text_of(&outcome), iso(0), id],
            )?;
            Self::revoke_callbacks(db, id)
        })
    }

    /// The run is over: its live callbacks close (`callbacks.revokeRun`).
    pub fn revoke_run_callbacks(&self, run_id: &str) -> Result<()> {
        Self::revoke_callbacks(&self.db, run_id)
    }

    fn revoke_callbacks(db: &Connection, run_id: &str) -> Result<()> {
        db.execute("update callback set status = 'revoked', revoked_at = ? where run_id = ? and status = 'live'", params![iso(0), run_id])?;
        Ok(())
    }

    /// The operator's cancel request on the run (its reason), or None.
    pub fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>> {
        Ok(self
            .db
            .query_row("select cancel_requested_at, cancel_reason from run where id = ?", params![id], |r| {
                Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .optional()?
            .and_then(|(at, reason)| at.map(|_| reason)))
    }

    pub fn run(&self, id: &str) -> Result<Option<RunRow>> {
        Ok(self.db.query_row("select id, file, movement, status, started_at, input, outcome from run where id = ?", params![id], run_row).optional()?)
    }

    /// The most recent runs first.
    pub fn runs(&self, limit: i64) -> Result<Vec<RunRow>> {
        let mut statement = self.db.prepare("select id, file, movement, status, started_at, input, outcome from run order by started_at desc limit ?")?;
        Ok(statement.query_map(params![limit], run_row)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ── Trace ───────────────────────────────────────────────────────────────

    pub fn append_trace(&self, run_id: &str, entries: &[Js]) -> Result<()> {
        self.transaction(|db| {
            let next: i64 = db.query_row("select coalesce(max(seq), -1) + 1 from trace where run_id = ?", params![run_id], |r| r.get(0))?;
            let mut insert = db.prepare("insert into trace (run_id, seq, entry) values (?, ?, ?)")?;
            for (i, entry) in entries.iter().enumerate() {
                insert.execute(params![run_id, next + i as i64, text_of(entry)])?;
            }
            Ok(())
        })
    }

    pub fn trace_entries(&self, run_id: &str) -> Result<Vec<Js>> {
        let mut statement = self.db.prepare("select entry from trace where run_id = ? order by seq")?;
        let texts = statement.query_map(params![run_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        texts.iter().map(|text| Js::parse(text.as_bytes()).map_err(StoreError::Backend)).collect()
    }

    pub fn run_spent(&self, run_id: &str) -> Result<f64> {
        Ok(self.db.query_row("select spent_microdollars - cost_cap_baseline_microdollars from run where id = ?", params![run_id], |r| r.get(0)).optional()?.unwrap_or(0.0))
    }

    pub fn add_run_spend(&self, run_id: &str, microdollars: f64) -> Result<()> {
        self.db.execute("update run set spent_microdollars = spent_microdollars + ? where id = ?", params![microdollars, run_id])?;
        Ok(())
    }

    pub fn reset_spend_baseline(&self, run_id: &str) -> Result<()> {
        self.db.execute("update run set cost_cap_baseline_microdollars = spent_microdollars where id = ?", params![run_id])?;
        Ok(())
    }

    pub fn trace_len(&self, run_id: &str) -> Result<i64> {
        Ok(self.db.query_row("select count(*) from trace where run_id = ?", params![run_id], |r| r.get(0))?)
    }

    // ── Parks ───────────────────────────────────────────────────────────────

    pub fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        // `rewritten` is not kept: lf has no limit resume to read it.
        reason_of(reason.to_string())?;
        self.fenced(run_id, fence, |db| Self::put_leaf_in(db, run_id, address, reason, wake_at, state))
    }

    fn put_leaf_in(db: &Connection, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js) -> Result<()> {
        db.execute(
            "insert into leaf (run_id, address, reason, status, wake_at, state) values (?, ?, ?, 'parked', ?, ?)
             on conflict (run_id, address) do update set
               reason = excluded.reason, status = 'parked', wake_at = excluded.wake_at, state = excluded.state",
            params![run_id, address, reason, wake_at, text_of(state)],
        )?;
        Ok(())
    }

    /// crate::backend::RunHostStore::commit_park: one transaction, fenced.
    pub fn commit_park(&self, park: &Park<'_>) -> Result<()> {
        let Park { run_id, address, state, fence, ref kind } = *park;
        self.fenced(run_id, fence, |db| {
            let wake_at = match kind {
                ParkKind::Timer { wake_at } => Some(*wake_at),
                ParkKind::Await { .. } | ParkKind::Limit => None,
            };
            Self::put_leaf_in(db, run_id, address, kind.reason(), wake_at, state)?;
            match kind {
                // The leaf is the truth; the work row only says when to look.
                ParkKind::Timer { wake_at } => Self::enqueue_in(db, "resume_timer", &timer_work_key(run_id), &timer_work_payload(run_id), Some(wake_at))?,
                ParkKind::Await { team_id, adapter_type, correlation_key } => Self::correlate_in(db, run_id, team_id, address, adapter_type, correlation_key)?,
                ParkKind::Limit => Self::drop_correlation_in(db, run_id, address)?,
            }
            Self::mark_parked_in(db, run_id)
        })
    }

    pub fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        let sql = format!(
            "update leaf set status = 'resuming' where run_id = ? and address = ? and status = 'parked' {} returning reason, state",
            if reason.is_some() { "and reason = ?" } else { "" }
        );
        let mut args: Vec<&str> = vec![run_id, address];
        args.extend(reason);
        let row = self.db.query_row(&sql, params_from_iter(args), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()?;
        row.map(|(reason, state)| Ok((reason_of(reason)?, parse_text(&state)?))).transpose()
    }

    pub fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Ok(());
            }
            db.execute("delete from leaf where run_id = ? and address = ? and status = 'resuming'", params![run_id, address])?;
            Ok(())
        })
    }

    pub fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        let mut clauses = vec!["run_id = ?"];
        let mut args: Vec<&str> = vec![run_id];
        if parked_only {
            clauses.push("status = 'parked'");
        }
        if let Some(reason) = reason {
            clauses.push("reason = ?");
            args.push(reason);
        }
        if let Some(due_by) = due_by {
            clauses.push("reason = 'timer' and wake_at <= ?");
            args.push(due_by);
        }
        let sql = format!("select address, reason, status, wake_at from leaf where {} order by address", clauses.join(" and "));
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(args), |r| Ok(LeafRow { address: r.get(0)?, reason: r.get(1)?, status: r.get(2)?, wake_at: r.get(3)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for row in &rows {
            reason_of(row.reason.clone())?;
        }
        Ok(rows)
    }

    pub fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        self.transaction(|db| {
            let mut drop = db.prepare("delete from leaf where run_id = ? and address = ?")?;
            for address in addresses {
                drop.execute(params![run_id, address])?;
            }
            Ok(())
        })
    }

    // ── Joins ───────────────────────────────────────────────────────────────

    pub fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        self.fenced(run_id, fence, |db| {
            db.execute(
                "insert into join_frame (run_id, frame_address, pending) values (?, ?, ?)
                 on conflict (run_id, frame_address) do update set pending = excluded.pending",
                params![run_id, frame_address, pending],
            )?;
            Ok(())
        })
    }

    /// True for the one branch that closes the frame, also on a retry of it.
    pub fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        self.transaction(|db| {
            let claimed = db.execute(
                "update join_branch_export set decremented = 1 where run_id = ? and frame_address = ? and branch_address = ? and decremented = 0",
                params![run_id, frame_address, branch_address],
            )?;
            if claimed > 0 {
                let updated: Option<i64> = db
                    .query_row(
                        "update join_frame set pending = pending - 1 where run_id = ? and frame_address = ? and pending > 0 returning pending",
                        params![run_id, frame_address],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(pending) = updated {
                    if pending > 0 {
                        return Ok(false);
                    }
                    db.execute(
                        "update join_frame set closed_by_address = ? where run_id = ? and frame_address = ?",
                        params![leaf_address, run_id, frame_address],
                    )?;
                    return Ok(true);
                }
            }
            let closed_by: Option<Option<String>> = db
                .query_row("select closed_by_address from join_frame where run_id = ? and frame_address = ?", params![run_id, frame_address], |r| r.get(0))
                .optional()?;
            Ok(closed_by.flatten().as_deref() == Some(leaf_address))
        })
    }

    pub fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        // A rewrite never touches `decremented`, the branch's decrement claim.
        self.db.execute(
            "insert into join_branch_export (run_id, frame_address, branch_address, branch_index, exports) values (?, ?, ?, ?, ?)
             on conflict (run_id, frame_address, branch_address) do update set exports = excluded.exports, branch_index = excluded.branch_index",
            params![run_id, frame_address, branch_address, branch_index, text_of(exports)],
        )?;
        Ok(())
    }

    pub fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        let mut statement =
            self.db.prepare("select branch_address, branch_index, exports from join_branch_export where run_id = ? and frame_address = ? order by branch_index")?;
        let rows = statement
            .query_map(params![run_id, frame_address], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(branch_address, branch_index, exports)| Ok(BranchExport { branch_address, branch_index, exports: parse_text(&exports)? }))
            .collect()
    }

    pub fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        Ok(self.db.query_row("select 1 from join_frame where run_id = ? and pending > 0 limit 1", params![run_id], |_| Ok(())).optional()?.is_some())
    }

    pub fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        let mut statement = self.db.prepare("select frame_address from join_frame where run_id = ? order by frame_address")?;
        Ok(statement.query_map(params![run_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        self.transaction(|db| {
            let mut drop_frame = db.prepare("delete from join_frame where run_id = ? and frame_address = ?")?;
            let mut drop_exports = db.prepare("delete from join_branch_export where run_id = ? and frame_address = ?")?;
            for frame in frame_addresses {
                drop_frame.execute(params![run_id, frame])?;
                drop_exports.execute(params![run_id, frame])?;
            }
            Ok(())
        })
    }

    // ── Correlations ────────────────────────────────────────────────────────

    pub fn correlate(&self, run_id: &str, team_id: &str, address: &str, adapter_type: &str, correlation_key: &str) -> Result<()> {
        Self::correlate_in(&self.db, run_id, team_id, address, adapter_type, correlation_key)
    }

    fn correlate_in(db: &Connection, run_id: &str, team_id: &str, address: &str, adapter_type: &str, correlation_key: &str) -> Result<()> {
        db.execute(
            "insert into await_correlation (run_id, team_id, address, adapter_type, correlation_key) values (?, ?, ?, ?, ?)
             on conflict (run_id, address) do update set
               team_id = excluded.team_id, adapter_type = excluded.adapter_type, correlation_key = excluded.correlation_key",
            params![run_id, team_id, address, adapter_type, correlation_key],
        )?;
        Ok(())
    }

    pub fn correlated(&self, adapter_type: &str, team_id: &str, correlation_key: &str) -> Result<Vec<CorrelatedAwait>> {
        let mut statement = self.db.prepare(
            "select run_id, team_id, address from await_correlation where team_id = ? and adapter_type = ? and correlation_key = ? order by run_id, address",
        )?;
        Ok(statement
            .query_map(params![team_id, adapter_type, correlation_key], |r| Ok(CorrelatedAwait { run_id: r.get(0)?, team_id: r.get(1)?, address: r.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn of_run(&self, run_id: &str, adapter_type: &str) -> Result<Vec<(CorrelatedAwait, String)>> {
        let mut statement =
            self.db.prepare("select run_id, team_id, address, correlation_key from await_correlation where run_id = ? and adapter_type = ? order by address")?;
        Ok(statement
            .query_map(params![run_id, adapter_type], |r| {
                Ok((CorrelatedAwait { run_id: r.get(0)?, team_id: r.get(1)?, address: r.get(2)? }, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn drop_correlation(&self, run_id: &str, address: &str) -> Result<()> {
        Self::drop_correlation_in(&self.db, run_id, address)
    }

    fn drop_correlation_in(db: &Connection, run_id: &str, address: &str) -> Result<()> {
        db.execute("delete from await_correlation where run_id = ? and address = ?", params![run_id, address])?;
        Ok(())
    }

    pub fn drop_run_correlations(&self, run_id: &str) -> Result<()> {
        self.db.execute("delete from await_correlation where run_id = ?", params![run_id])?;
        Ok(())
    }

    // ── The run lease ───────────────────────────────────────────────────────

    pub fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        let token = uuid();
        self.transaction(|db| {
            let claimed = db.execute(
                "update run set lease_token = ?, lease_until = ? where id = ? and (lease_until is null or lease_until < ?)",
                params![token, iso(ttl_ms), run_id, iso(0)],
            )?;
            if claimed == 0 {
                return Ok(None);
            }
            db.execute("update leaf set status = 'parked' where run_id = ? and status = 'resuming'", params![run_id])?;
            Ok(Some(token))
        })
    }

    pub fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        let renewed = self.db.execute(
            "update run set lease_until = ? where id = ? and lease_token = ? and lease_until > ?",
            params![iso(ttl_ms), run_id, token, iso(0)],
        )?;
        Ok(renewed > 0)
    }

    pub fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        self.db.execute("update run set lease_token = null, lease_until = null where id = ? and lease_token = ?", params![run_id, token])?;
        Ok(())
    }

    pub fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Ok(false);
            }
            db.execute("delete from leaf where run_id = ?", params![run_id])?;
            db.execute("delete from join_frame where run_id = ?", params![run_id])?;
            db.execute("delete from join_branch_export where run_id = ?", params![run_id])?;
            Ok(true)
        })
    }

    // ── The work queue ──────────────────────────────────────────────────────

    pub fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>) -> Result<()> {
        Self::enqueue_in(&self.db, kind, key, payload, due_at)
    }

    pub(crate) fn enqueue_in(db: &Connection, kind: &str, key: &str, payload: &Js, due_at: Option<&str>) -> Result<()> {
        if !WORK_KINDS.contains(&kind) {
            return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
        }
        // Against a held row the new due time wins: its holder's completion
        // leaves the row for the re-arm. A dead row queued again is new
        // work: it lives again, its attempts from nought.
        let now = iso(0);
        db.execute(
            "insert into work (kind, key, payload, due_at) values (?, ?, ?, ?)
             on conflict (key) do update set
               due_at = case when work.dead_at is not null then excluded.due_at
                             when work.lease_until > ? then excluded.due_at else min(work.due_at, excluded.due_at) end,
               payload = excluded.payload,
               attempts = case when work.dead_at is null then work.attempts else 0 end,
               dead_at = null,
               dead_reason = null,
               version = work.version + 1",
            params![kind, key, text_of(payload), due_at.unwrap_or(&now), now],
        )?;
        Ok(())
    }

    pub fn claim_due(&self, claim: &ClaimDue<'_>) -> Result<Vec<ClaimedWork>> {
        let now = iso(0);
        let due_by = claim.due_by.map(str::to_string).unwrap_or_else(|| now.clone());
        let kinds = Js::strings(claim.kinds()?).to_json();
        let lease_ms = claim.lease_ms;
        self.transaction(|db| {
            let mut select = db.prepare(
                "select id, kind, key, payload, version, attempts from work
                 where due_at <= ? and (lease_until is null or lease_until < ?) and dead_at is null and kind in (select value from json_each(?))
                 order by due_at, id limit ?",
            )?;
            let due = select
                .query_map(params![due_by, now, kinds, claim.limit], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut lease = db.prepare("update work set lease_token = ?, lease_until = ?, version = version + 1, attempts = attempts + 1 where id = ?")?;
            due.into_iter()
                .map(|(id, kind, key, payload, version, attempts)| {
                    if !WORK_KINDS.contains(&kind.as_str()) {
                        return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
                    }
                    let lease_token = uuid();
                    lease.execute(params![lease_token, iso(lease_ms), id])?;
                    let claim = format!("{lease_token}/{}", version + 1);
                    Ok(ClaimedWork { id: id.to_string(), kind, key, payload: parse_text(&payload)?, claim, attempts: attempts + 1 })
                })
                .collect()
        })
    }

    pub fn complete(&self, id: &str, claim: &str) -> Result<()> {
        // Deleted only when nothing re-armed it since the claim; else the
        // re-armed row stays, unleased, for its new due time.
        let (lease_token, version) = work_claim(claim)?;
        let id = work_id(id)?;
        self.transaction(|db| {
            db.execute("delete from work where id = ? and lease_token = ? and version = ?", params![id, lease_token, version])?;
            db.execute("update work set lease_token = null, lease_until = null where id = ? and lease_token = ?", params![id, lease_token])?;
            Ok(())
        })
    }

    pub fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>, why: Release) -> Result<()> {
        let (lease_token, version) = work_claim(claim)?;
        let attempts = match why {
            Release::Failed => "attempts",
            Release::Busy => "max(attempts - 1, 0)",
            Release::Rescheduled => "0",
        };
        self.db.execute(
            &format!(
                "update work set lease_token = null, lease_until = null, attempts = {attempts},
                   due_at = case when version = ? then coalesce(?, due_at) else due_at end
                 where id = ? and lease_token = ?"
            ),
            params![version, due_at, work_id(id)?, lease_token],
        )?;
        Ok(())
    }

    /// crate::backend::RunHostStore::bury_work: dead, unless re-armed since
    /// the claim (as `complete`): then only unleased, for its new due time.
    pub fn bury_work(&self, id: &str, claim: &str, reason: &str) -> Result<()> {
        let (lease_token, version) = work_claim(claim)?;
        let id = work_id(id)?;
        self.transaction(|db| {
            db.execute(
                "update work set dead_at = ?, dead_reason = ? where id = ? and lease_token = ? and version = ?",
                params![iso(0), reason, id, lease_token, version],
            )?;
            db.execute("update work set lease_token = null, lease_until = null where id = ? and lease_token = ?", params![id, lease_token])?;
            Ok(())
        })
    }

    // ── Library sources ─────────────────────────────────────────────────────

    pub fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        self.db.execute("insert into park_library_source (team_id, hash, source) values (?, ?, ?) on conflict do nothing", params![team_id, hash, source])?;
        Ok(())
    }

    pub fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("select source from park_library_source where team_id = ? and hash = ?", params![team_id, hash], |r| r.get(0)).optional()?)
    }

    /// crate::backend::RunHostStore::claim_event.
    pub fn claim_event(&self, listen: &str, key: &str) -> Result<bool> {
        Self::claim_event_in(&self.db, listen, key)
    }

    fn claim_event_in(db: &Connection, listen: &str, key: &str) -> Result<bool> {
        let inserted = db.execute("insert into event_receipt (listen, key, received_at) values (?, ?, ?) on conflict do nothing", params![listen, key, iso(0)])?;
        Ok(inserted == 1)
    }
}

/// `Number(work.id)`: the row id a claim names.
fn work_id(id: &str) -> Result<i64> {
    id.parse().map_err(|_| StoreError::Invalid(format!("not a work id: {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instants_are_written_as_to_iso_string_writes_them() {
        let now = iso(0);
        assert_eq!(now.len(), "2026-10-17T12:00:00.000Z".len(), "{now}");
        assert!(now.ends_with('Z') && now.as_bytes()[19] == b'.', "{now}");
        assert!(iso(60_000) > now);
    }

    #[test]
    fn a_work_claim_is_a_token_and_a_version() {
        assert_eq!(work_claim("abc/3").unwrap(), ("abc".to_string(), 3));
        assert!(work_claim("/3").is_err());
        assert!(work_claim("abc").is_err());
    }

    /// A fresh state file, and its path for a second handle.
    fn state_file() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("lf-state-{}", uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        (Store::open(&path).unwrap(), path)
    }

    #[test]
    fn an_event_key_is_received_once_per_listen() {
        let (store, path) = state_file();
        assert!(store.claim_event("listen:a:welcome", "delivery-1").unwrap());
        assert!(!store.claim_event("listen:a:welcome", "delivery-1").unwrap());
        assert!(store.claim_event("listen:a:other", "delivery-1").unwrap());
        // Kept in the state file: another handle sees the receipt.
        assert!(!Store::open(&path).unwrap().claim_event("listen:a:welcome", "delivery-1").unwrap());
    }

    fn work_row(store: &Store, key: &str) -> (String, Option<String>) {
        store.db.query_row("select due_at, lease_token from work where key = ?", params![key], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
    }

    fn claim(limit: i64, lease_ms: i64) -> ClaimDue<'static> {
        ClaimDue { limit, lease_ms, due_by: None, kinds: None }
    }

    fn no_payload() -> Js {
        Js::Obj(crate::json::Obj::new())
    }

    #[test]
    fn enqueue_against_a_row_whose_lease_lapsed_keeps_the_earlier_due_time() {
        let (store, _) = state_file();
        let due = iso(-60_000);
        store.enqueue("resume_timer", "k", &no_payload(), Some(&due)).unwrap();
        // Claimed under a lease that has already lapsed.
        assert_eq!(store.claim_due(&claim(10, -1)).unwrap().len(), 1);
        store.enqueue("resume_timer", "k", &no_payload(), Some(&iso(3_600_000))).unwrap();
        assert_eq!(work_row(&store, "k").0, due);
    }

    #[test]
    fn a_release_without_a_retry_time_keeps_the_due_time_and_clears_the_lease() {
        let (store, _) = state_file();
        let due = iso(-60_000);
        store.enqueue("wake_await", "k", &no_payload(), Some(&due)).unwrap();
        let claimed = store.claim_due(&claim(10, 60_000)).unwrap().pop().unwrap();
        assert!(work_row(&store, "k").1.is_some());
        store.release_work(&claimed.id, &claimed.claim, None, Release::Failed).unwrap();
        assert_eq!(work_row(&store, "k"), (due, None));
    }

    #[test]
    fn two_handles_on_one_file_claim_disjoint_rows() {
        let (store, path) = state_file();
        let other = Store::open(&path).unwrap();
        for i in 0..6 {
            store.enqueue("wake_await", &format!("k{i}"), &no_payload(), Some(&iso(-1_000))).unwrap();
        }
        let mut keys: Vec<String> = store.claim_due(&claim(3, 60_000)).unwrap().into_iter().map(|w| w.key).collect();
        keys.extend(other.claim_due(&claim(3, 60_000)).unwrap().into_iter().map(|w| w.key));
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), 6);
    }

    #[test]
    fn a_claim_naming_kinds_leases_only_rows_of_those_kinds() {
        let (store, _) = state_file();
        for (kind, key) in [("poll_listen", "p1"), ("resume_timer", "t1"), ("poll_listen", "p2"), ("fire_event", "e1")] {
            store.enqueue(kind, key, &no_payload(), Some(&iso(-1_000))).unwrap();
        }
        let polls = [String::from("poll_listen")];
        let mut keys: Vec<String> = store.claim_due(&ClaimDue { kinds: Some(&polls), ..claim(10, 60_000) }).unwrap().into_iter().map(|w| w.key).collect();
        keys.sort();
        assert_eq!(keys, ["p1", "p2"]);
        let rest: Vec<String> = store.claim_due(&claim(10, 60_000)).unwrap().into_iter().map(|w| w.key).collect();
        assert_eq!(rest, ["t1", "e1"]);
        let unknown = [String::from("resume_callback")];
        assert!(matches!(store.claim_due(&ClaimDue { kinds: Some(&unknown), ..claim(10, 60_000) }), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn a_kind_lf_does_not_drain_is_refused_at_the_queue() {
        let (store, _) = state_file();
        assert!(matches!(store.enqueue("resume_callback", "k", &no_payload(), None), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn a_lapsed_run_lease_is_taken_by_another_process_with_the_abandoned_claim_parked_again() {
        let (store, path) = state_file();
        store.start_run("run-1", "f", "m", &iso(0), "{}").unwrap();
        store.put_leaf("run-1", "s1", "timer", Some(&iso(-1_000)), &no_payload(), None).unwrap();
        let first = store.claim_lease("run-1", 60_000).unwrap().expect("the run was free");
        assert!(store.claim_leaf("run-1", "s1", None).unwrap().is_some());
        let other = Store::open(&path).unwrap();
        assert_eq!(other.claim_lease("run-1", 60_000).unwrap(), None, "one holder at a time");
        // The first holder's lease lapses (its process stalled past it).
        store.db.execute("update run set lease_until = ? where id = 'run-1'", params![iso(-1)]).unwrap();
        assert!(!store.renew_lease("run-1", &first, 60_000).unwrap());
        assert!(other.claim_lease("run-1", 60_000).unwrap().is_some());
        let parked: Vec<String> = other.leaves("run-1", true, None, None).unwrap().into_iter().map(|l| l.address).collect();
        assert_eq!(parked, ["s1"]);
    }

    /// A write that fails partway: the statement `on` names aborts, as a
    /// crash between the old separate writes would have stopped them.
    fn failing(store: &Store, name: &str, on: &str) {
        store.db.execute_batch(&format!("create trigger {name} {on} begin select raise(abort, 'injected'); end;")).unwrap();
    }

    fn unfail(store: &Store, name: &str) {
        store.db.execute_batch(&format!("drop trigger {name}")).unwrap();
    }

    fn status(store: &Store, run_id: &str) -> String {
        store.run(run_id).unwrap().unwrap().status
    }

    fn work_keys(store: &Store) -> Vec<String> {
        let mut statement = store.db.prepare("select key from work order by key").unwrap();
        statement.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    fn running(store: &Store, run_id: &str) -> String {
        store.start_run(run_id, "f", "m", &iso(0), "{}").unwrap();
        store.claim_lease(run_id, 60_000).unwrap().unwrap()
    }

    #[test]
    fn a_timer_park_is_its_leaf_its_wake_and_the_run_parked_or_none_of_them() {
        let (store, _) = state_file();
        let fence = running(&store, "run-1");
        let wake_at = iso(60_000);
        let park = Park { run_id: "run-1", address: "s1", state: &no_payload(), fence: Some(&fence), kind: ParkKind::Timer { wake_at: &wake_at } };
        // Before: the leaf was written, then the crash, and nothing ever woke it.
        failing(&store, "no_work", "before insert on work");
        assert!(store.commit_park(&park).is_err());
        assert!(store.leaves("run-1", false, None, None).unwrap().is_empty());
        assert_eq!(status(&store, "run-1"), "running");
        unfail(&store, "no_work");
        store.commit_park(&park).unwrap();
        assert_eq!(store.leaves("run-1", true, Some("timer"), None).unwrap()[0].wake_at.as_deref(), Some(wake_at.as_str()));
        assert_eq!(work_row(&store, "resume_timer:run-1").0, wake_at);
        assert_eq!(status(&store, "run-1"), "parked");
    }

    #[test]
    fn an_await_park_is_kept_with_its_correlation_and_a_limit_park_with_its_drop() {
        let (store, _) = state_file();
        let fence = running(&store, "run-1");
        let kind = ParkKind::Await { team_id: "local", adapter_type: "mail", correlation_key: "thread-1" };
        let park = Park { run_id: "run-1", address: "s1", state: &no_payload(), fence: Some(&fence), kind };
        failing(&store, "no_correlation", "before insert on await_correlation");
        assert!(store.commit_park(&park).is_err());
        assert!(store.leaves("run-1", false, None, None).unwrap().is_empty());
        unfail(&store, "no_correlation");
        store.commit_park(&park).unwrap();
        assert_eq!(store.correlated("mail", "local", "thread-1").unwrap()[0].address, "s1");
        // The run's status is the last write: failing it undoes the leaf and the drop.
        let limit = Park { run_id: "run-1", address: "s1", state: &no_payload(), fence: Some(&fence), kind: ParkKind::Limit };
        failing(&store, "no_status", "before update of status on run");
        assert!(store.commit_park(&limit).is_err());
        assert_eq!(store.leaves("run-1", false, None, None).unwrap()[0].reason, "await");
        assert_eq!(store.correlated("mail", "local", "thread-1").unwrap().len(), 1);
        unfail(&store, "no_status");
        store.commit_park(&limit).unwrap();
        assert!(store.correlated("mail", "local", "thread-1").unwrap().is_empty());
    }

    #[test]
    fn a_park_under_a_lost_lease_writes_nothing() {
        let (store, _) = state_file();
        running(&store, "run-1");
        let wake_at = iso(1_000);
        let park = Park { run_id: "run-1", address: "s1", state: &no_payload(), fence: Some("not-the-lease"), kind: ParkKind::Timer { wake_at: &wake_at } };
        assert!(matches!(store.commit_park(&park), Err(StoreError::LeaseLost { .. })));
        assert!(store.leaves("run-1", false, None, None).unwrap().is_empty());
        assert!(work_keys(&store).is_empty());
        assert_eq!(status(&store, "run-1"), "running");
    }

    #[test]
    fn an_event_receipt_and_its_run_are_one_write() {
        let (store, _) = state_file();
        let start = |id: &'static str| RunStart { id, file: "f", movement: "m", started_at: "2026-10-20T00:00:00.000Z", input: "{}" };
        // Before: the receipt was noted, then the crash, and the event never ran.
        failing(&store, "no_run", "before insert on run");
        assert!(store.start_event_run("listen:f:m", "delivery-1", &start("run-1")).is_err());
        unfail(&store, "no_run");
        assert!(store.start_event_run("listen:f:m", "delivery-1", &start("run-1")).unwrap(), "its receipt went with the failed run");
        assert!(!store.start_event_run("listen:f:m", "delivery-1", &start("run-2")).unwrap());
        assert!(store.run("run-1").unwrap().is_some());
        assert!(store.run("run-2").unwrap().is_none(), "a redelivery starts no run");
    }

    #[test]
    fn a_delivery_keeps_its_cursor_only_with_its_work() {
        let (store, _) = state_file();
        let cursor = Js::str("c-2");
        let row = |key: &str| NewWork { kind: "fire_event".into(), key: key.into(), payload: no_payload(), due_at: None, team_id: None };
        let work = [row("fire_event:1"), row("fire_event:2")];
        // Before: the cursor moved past events that were then never queued.
        failing(&store, "no_work", "before insert on work");
        assert!(store.keep_delivery("sub", Some(&cursor), &work).is_err());
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), None);
        unfail(&store, "no_work");
        store.keep_delivery("sub", Some(&cursor), &work).unwrap();
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), Some(cursor));
        assert_eq!(work_keys(&store), ["fire_event:1", "fire_event:2"]);
        // No cursor: the saved one stays.
        store.keep_delivery("sub", None, &[row("fire_event:3")]).unwrap();
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), Some(Js::str("c-2")));
    }

    #[test]
    fn a_run_is_lapsed_when_it_is_running_without_a_live_lease_a_lease_length_after_it_started() {
        let (store, _) = state_file();
        let long_ago = iso(-120_000);
        let start = |id: &str, at: &str| store.start_run(id, "f", "m", at, "{}").unwrap();
        let lease_until = |id: &str, until: Option<String>| {
            store.db.execute("update run set lease_token = 't', lease_until = ? where id = ?", params![until, id]).unwrap();
        };
        start("lapsed", &long_ago);
        lease_until("lapsed", Some(iso(-1_000)));
        start("live", &long_ago);
        lease_until("live", Some(iso(40_000)));
        start("never-leased", &long_ago);
        start("just-started", &iso(0));
        start("parked", &long_ago);
        store.mark_parked("parked").unwrap();
        assert_eq!(store.lapsed_runs(60_000, 10).unwrap(), ["lapsed", "never-leased"]);
    }

    #[test]
    fn a_rows_attempts_count_its_claims_less_those_busy_and_start_over_when_it_succeeds() {
        let (store, _) = state_file();
        let due_soon = || claim(10, 60_000);
        store.enqueue("resume_timer", "k", &no_payload(), Some(&iso(-1_000))).unwrap();
        let first = store.claim_due(&due_soon()).unwrap().pop().unwrap();
        assert_eq!(first.attempts, 1);
        store.release_work(&first.id, &first.claim, Some(&iso(-1_000)), Release::Failed).unwrap();
        let second = store.claim_due(&due_soon()).unwrap().pop().unwrap();
        assert_eq!(second.attempts, 2);
        store.release_work(&second.id, &second.claim, Some(&iso(-1_000)), Release::Busy).unwrap();
        let third = store.claim_due(&due_soon()).unwrap().pop().unwrap();
        assert_eq!(third.attempts, 2, "a busy release gives its attempt back");
        store.release_work(&third.id, &third.claim, Some(&iso(-1_000)), Release::Rescheduled).unwrap();
        assert_eq!(store.claim_due(&due_soon()).unwrap().pop().unwrap().attempts, 1);
    }

    #[test]
    fn a_buried_row_is_never_claimed_until_it_is_queued_again() {
        let (store, _) = state_file();
        store.enqueue("wake_await", "k", &no_payload(), Some(&iso(-1_000))).unwrap();
        let claimed = store.claim_due(&claim(10, 60_000)).unwrap().pop().unwrap();
        store.bury_work(&claimed.id, &claimed.claim, "gave up").unwrap();
        let dead: (Option<String>, Option<String>) = store.db.query_row("select dead_reason, lease_token from work where key = 'k'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(dead, (Some("gave up".into()), None));
        assert!(store.claim_due(&claim(10, 60_000)).unwrap().is_empty());
        store.enqueue("wake_await", "k", &no_payload(), Some(&iso(-1_000))).unwrap();
        assert_eq!(store.claim_due(&claim(10, 60_000)).unwrap().pop().unwrap().attempts, 1);
        // Re-armed during its claim, a row is not buried: the new work stands.
        store.enqueue("resume_timer", "t", &no_payload(), Some(&iso(-1_000))).unwrap();
        let held = store.claim_due(&claim(10, 60_000)).unwrap().pop().unwrap();
        store.enqueue("resume_timer", "t", &no_payload(), Some(&iso(-500))).unwrap();
        store.bury_work(&held.id, &held.claim, "gave up").unwrap();
        assert_eq!(store.claim_due(&claim(10, 60_000)).unwrap().len(), 1);
    }
}
