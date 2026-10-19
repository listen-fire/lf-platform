//! The shared half of `lf serve` (the listening half is src/listener.rs, behind
//! the `serve` cargo feature): `lf serve`: the inbound doors and the work queue. A provider's delivery at
//! `/api/public/webhook-sync/<provider>/<install>` is verified and read by
//! its external and its events queued, `/hooks/<external>/<install>` being
//! lf's older name for the same door; an external's pushes arrive at
//! `/api/public/adapter/<external>/{emit,wake}` and are queued; a callback's
//! call arrives at `/api/cb/<id>` (its url) and runs its body; a provider's
//! OAuth redirect for `lf credential add --public` arrives at GET
//! `/oauth/callback`; an exposed file is fetched at GET `/files/<id>`. Due
//! work — an emitted event, a parked run's timer, a queued await wake, a
//! call's body — is drained on a tick, and at once when a door queues some.
//!
//! The server listens before the session opens, so the externals the session
//! starts are told where to push (LF_HOST_URL). Also here: `lf call`,
//! `lf cancel` and `lf run --webhook`, the other ways in.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::backend::{StoreSpec, open_store};
use crate::callbacks::CallOutcome;
use crate::doors::Webhook;
use crate::json::{Js, Obj};
use crate::project::Project;
use crate::runs::{Cancelled, RunOutcome, Session, cancel_run, open_session, report};


/// Where this process serves, once `serve` listens: every external started
/// after it is told (LF_HOST_URL), and a callback's url falls back to it.
pub(crate) static HOST_URL: OnceLock<String> = OnceLock::new();

pub fn host_url() -> Option<&'static str> {
    HOST_URL.get().map(String::as_str)
}

/// The token this process's doors take from the externals it starts
/// (LF_HOST_TOKEN), for the models door.
pub(crate) static HOST_TOKEN: OnceLock<String> = OnceLock::new();

pub fn host_token() -> Option<&'static str> {
    HOST_TOKEN.get().map(String::as_str)
}

/// Outside `lf serve` (a plain `lf run`, `resume`, `drain`, …): a loopback
/// listener with the models door alone, so a module can still ask the
/// host for a model call.
pub(crate) static MODELS_DOOR_URL: OnceLock<String> = OnceLock::new();

/// Where the externals this process starts reach its doors (LF_HOST_URL).
pub fn externals_host_url() -> Option<&'static str> {
    host_url().or_else(|| MODELS_DOOR_URL.get().map(String::as_str))
}

// ── The other ways in: lf call, lf cancel, lf run --webhook ─────────────────

/// What `lf call` was given.
pub struct CallArgs<'a> {
    pub id: Option<&'a str>,
    pub body: Option<&'a Path>,
    pub json: bool,
}

/// `lf call <callback-id> [--body <values.json>]`.
pub async fn call_command(project: Project, store: &StoreSpec, args: CallArgs<'_>, out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    let CallArgs { id, body, json } = args;
    let Some(id) = id else {
        eprintln!("lf call needs a callback id");
        return Ok(2);
    };
    let supplied = match body {
        None => Js::Obj(Obj::new()),
        Some(path) => Js::parse(&std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)?,
    };
    let Js::Obj(values) = supplied else {
        eprintln!("lf call --body: the file must hold a JSON object of values");
        return Ok(2);
    };
    let session = open_session(project, false, store).await?;
    let called = session.call_callback(id, &values).await?;
    if json {
        let (result, message) = match &called.call {
            CallOutcome::Recorded { .. } => ("recorded", None),
            CallOutcome::Mismatch(message) => ("refused", Some(message.as_str())),
            CallOutcome::NotFound => ("notFound", None),
            CallOutcome::Closed => ("closed", None),
            CallOutcome::Expired => ("expired", None),
        };
        let code = if result == "recorded" { crate::lfjson::exit_of(&called.outcomes) } else { 1 };
        return crate::lfjson::emit(out, &crate::lfjson::call_doc(id, result, message, called.queued, &called.outcomes), code);
    }
    match &called.call {
        CallOutcome::Recorded { .. } => {
            if called.queued {
                writeln!(out, "callback {id}: recorded; its run is being stepped by another lf process, which runs the body next").map_err(io)?;
            } else {
                writeln!(out, "callback {id}: recorded").map_err(io)?;
            }
            if called.outcomes.is_empty() { Ok(0) } else { report(&called.outcomes, out) }
        }
        CallOutcome::Mismatch(message) => {
            writeln!(out, "callback {id}: refused — {message}").map_err(io)?;
            Ok(1)
        }
        CallOutcome::NotFound => {
            writeln!(out, "callback {id}: no such callback").map_err(io)?;
            Ok(1)
        }
        CallOutcome::Closed => {
            writeln!(out, "callback {id}: closed — it was already used, or its run has finished").map_err(io)?;
            Ok(1)
        }
        CallOutcome::Expired => {
            writeln!(out, "callback {id}: expired").map_err(io)?;
            Ok(1)
        }
    }
}

/// `lf cancel <run-id> [--reason <text>]`. Settling a run starts no segment:
/// no externals, just the store.
pub async fn cancel_command(store: &StoreSpec, run_id: Option<&str>, reason: Option<&str>, json: bool, out: &mut impl Write) -> Result<i32, String> {
    let Some(run_id) = run_id else {
        eprintln!("lf cancel needs a run id");
        return Ok(2);
    };
    let store = open_store(store)?;
    let cancelled = cancel_run(&*store, run_id, reason).await?;
    if json {
        let result = match cancelled {
            Cancelled::Now => "cancelled",
            Cancelled::Requested => "cancelRequested",
        };
        return crate::lfjson::emit(out, &crate::lfjson::cancel_doc(run_id, result), 0);
    }
    let line = match cancelled {
        Cancelled::Now => format!("run {run_id} cancelled"),
        Cancelled::Requested => format!("run {run_id}: cancel requested; another lf process is stepping it, and it stops at its next statement"),
    };
    writeln!(out, "{line}").map_err(|e| e.to_string())?;
    Ok(0)
}

/// `lf run --webhook <external> --body <file> [--install <credential>] [--header k:v]…`.
pub struct WebhookFile<'a> {
    pub external: &'a str,
    pub install: Option<&'a str>,
    pub body: &'a PathBuf,
    /// `name:value` each.
    pub headers: &'a [String],
}

pub async fn receive_webhook(session: &Session, file: WebhookFile<'_>) -> Result<Vec<RunOutcome>, String> {
    let raw_body = std::fs::read(file.body).map_err(|e| format!("{}: {e}", file.body.display()))?;
    let headers = file
        .headers
        .iter()
        .map(|pair| match pair.find(':').filter(|at| *at > 0) {
            Some(at) => Ok((pair[..at].trim().to_lowercase(), pair[at + 1..].trim().to_string())),
            None => Err(format!("--header {pair}: expected name:value")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    crate::doors::receive_webhook(session, Webhook { external: file.external, install: file.install, raw_body: &raw_body, headers: &headers }).await
}
