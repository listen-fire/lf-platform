//! A core module filling a slot from outside lf, spoken to over adapter
//! protocol 2's HTTP (crate::module_transport): one POST per method, the
//! envelope `{ ok, result }` or `{ ok: false, error }`, the install's
//! declared settings carried on every request. The slots' families are
//! called synchronously (the run host's store, the limiter, the loop guard
//! all answer before the caller goes on), so the calls are made on a thread
//! of their own with its own runtime and the caller waits for the answer, as
//! it waited on a database.
//!
//! The module is either reached at its `url` (a remote module: only a
//! manifest on this box), or started from its `command`: told where to listen
//! (`MODULE_SOCKET`, else `PORT=0`) and which token to require
//! (`MODULE_TOKEN`), and read off the `listening …` line it prints.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::obj;
use crate::outgoing_auth::OutgoingAuth;
use crate::protocol::PROTOCOL_VERSION;

/// How long a started module has to say where it listens.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a call failed: the module's own `{ code, message, data? }`, or a
/// transport fault (`code` `transport`).
#[derive(Debug, Clone, PartialEq)]
pub struct SlotError {
    pub code: String,
    pub message: String,
    pub data: Option<Js>,
}

impl SlotError {
    fn transport(message: String) -> SlotError {
        SlotError { code: "transport".into(), message, data: None }
    }
}

type Job = (String, mpsc::Sender<Result<Js, SlotError>>);

pub struct SlotClient {
    /// The module, as messages name it ("the store module acme_store").
    pub label: String,
    pub base_url: String,
    bearer: Option<String>,
    auth: Option<OutgoingAuth>,
    jobs: Option<mpsc::Sender<Job>>,
    worker: Option<std::thread::JoinHandle<()>>,
    settings: Obj,
    started: Option<Started>,
}

struct Started {
    child: Child,
    socket: Option<PathBuf>,
}

impl SlotClient {
    /// Reach `module` (its url, or a process started from its command),
    /// under its install's `fields` (its settings, its secret, its outgoing auth).
    pub fn start(kind: &str, name: &str, process: &ProcessModule, fields: &BTreeMap<String, String>) -> Result<SlotClient, String> {
        let label = format!("the {kind} module {name}");
        // Its settings: every field but what proves lf to it and to its platform.
        let declared: Obj = fields
            .iter()
            .filter(|(k, _)| !k.starts_with("outgoing_") && Some(k.as_str()) != process.auth_field.as_deref())
            .map(|(k, v)| (k.clone(), Js::str(v)))
            .collect();
        let (base_url, bearer, started) = match &process.url {
            Some(url) => (url.clone(), process.auth_field.as_ref().and_then(|f| fields.get(f)).cloned(), None),
            None => {
                let token = crate::http_out::hex(&crate::http_out::random_bytes(24)?);
                let (base_url, started) = spawn(&label, process, &token)?;
                (base_url, Some(token), Some(started))
            }
        };
        let auth = OutgoingAuth::of_fields(fields, &base_url).map_err(|e| format!("{label}: {e}"))?;
        let (jobs, received) = mpsc::channel::<Job>();
        let (url, worker_label, worker_bearer, worker_auth) = (base_url.clone(), label.clone(), bearer.clone(), auth.clone());
        let worker = std::thread::Builder::new()
            .name(format!("lf {name}"))
            .spawn(move || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
                while let Ok((body, reply)) = received.recv() {
                    let answered = runtime.block_on(post(&worker_label, &url, worker_bearer.as_deref(), worker_auth.as_ref(), body));
                    let _ = reply.send(answered);
                }
            })
            .map_err(|e| format!("{label}: no thread to call it from: {e}"))?;
        Ok(SlotClient { label, base_url, bearer, auth, jobs: Some(jobs), worker: Some(worker), settings: declared, started })
    }

    /// The settings the install gives the module's declared settings.
    pub fn settings(&self) -> Obj {
        self.settings.clone()
    }

    /// The secret the module requires (`Authorization: Bearer …`).
    pub fn bearer(&self) -> Option<&str> {
        self.bearer.as_deref()
    }

    fn body(&self, method: &str, params: Obj) -> String {
        Js::from(obj! {
            "protocolVersion" => Js::str(PROTOCOL_VERSION),
            "method" => Js::str(method),
            "cacheScopeId" => Js::str("<slot>"),
            "params" => Js::from(params),
            "settings" => Js::from(self.settings.clone()),
        })
        .to_json()
    }

    fn named(&self, method: &str, mut error: SlotError) -> SlotError {
        if error.code == "transport" {
            error.message = format!("{}: {method}: {}", self.label, error.message);
        }
        error
    }

    /// One method, the caller waiting; its result, or the module's error.
    pub fn call(&self, method: &str, params: Obj) -> Result<Js, SlotError> {
        let (reply, answer) = mpsc::channel();
        let jobs = self.jobs.as_ref().ok_or_else(|| SlotError::transport(format!("{} is closed", self.label)))?;
        jobs.send((self.body(method, params), reply)).map_err(|_| SlotError::transport(format!("{} is closed", self.label)))?;
        answer.recv().unwrap_or_else(|_| Err(SlotError::transport("no answer".into()))).map_err(|e| self.named(method, e))
    }

    /// One method awaited on the caller's runtime: for a slot whose calls
    /// are long (a model's answer), so the run's other requests go on meanwhile.
    pub async fn call_async(&self, method: &str, params: Obj) -> Result<Js, String> {
        post(&self.label, &self.base_url, self.bearer.as_deref(), self.auth.as_ref(), self.body(method, params))
            .await
            .map_err(|e| self.named(method, e))
            .map_err(|e| self.text(method, e))
    }

    fn text(&self, method: &str, error: SlotError) -> String {
        if error.code == "transport" { error.message } else { format!("{}: {method}: {}", self.label, error.message) }
    }

    /// `call`, a failure as one message.
    pub fn call_text(&self, method: &str, params: Obj) -> Result<Js, String> {
        self.call(method, params).map_err(|e| self.text(method, e))
    }
}

impl Drop for SlotClient {
    fn drop(&mut self) {
        self.jobs.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Some(mut started) = self.started.take() {
            let _ = started.child.kill();
            let _ = started.child.wait();
            if let Some(socket) = started.socket {
                let _ = std::fs::remove_file(socket);
            }
        }
    }
}

async fn post(label: &str, base_url: &str, bearer: Option<&str>, auth: Option<&OutgoingAuth>, body: String) -> Result<Js, SlotError> {
    let headers = crate::protocol::envelope_headers(crate::check::LOCAL_TENANT, bearer, auth).await.map_err(SlotError::transport)?;
    let answer = crate::module_transport::post(base_url, &headers, body.into_bytes()).await.map_err(|e| SlotError::transport(format!("could not be reached at {base_url}: {e}")))?;
    if !(200..300).contains(&answer.status) {
        return Err(SlotError::transport(format!("answered HTTP {}", answer.status)));
    }
    let envelope = Js::parse(&answer.body).map_err(|e| SlotError::transport(format!("its answer is not JSON: {e}")))?;
    match envelope.get("ok") {
        Some(Js::Bool(true)) => Ok(envelope.get("result").cloned().unwrap_or(Js::Null)),
        Some(Js::Bool(false)) => {
            let error = envelope.get("error");
            let field = |k: &str| error.and_then(|e| e.get(k)).and_then(Js::as_str).map(str::to_string);
            Err(SlotError {
                code: field("code").unwrap_or_else(|| "module_error".into()),
                message: field("message").unwrap_or_else(|| "no message".into()),
                data: error.and_then(|e| e.get("data")).cloned(),
            })
        }
        _ => Err(SlotError::transport(format!("{label} answered {}, not the protocol's envelope", envelope.to_json()))),
    }
}

/// Start the module in its folder and read where it listens.
fn spawn(label: &str, process: &ProcessModule, token: &str) -> Result<(String, Started), String> {
    let (program, args) = process.command.split_first().ok_or_else(|| format!("{label} has neither a command nor a url"))?;
    let socket = crate::module_transport::fresh_socket_path();
    let mut child = Command::new(program)
        .args(args)
        .current_dir(&process.dir)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .envs(crate::module_transport::listen_env(socket.as_deref()))
        .env("MODULE_TOKEN", token)
        .envs(&process.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("{label}: {program} could not be started ({e})"))?;
    let stdout = child.stdout.take().ok_or_else(|| format!("{label}: no stdout"))?;
    let (heard, listened) = mpsc::channel();
    // Reads on after the line, so a full pipe never blocks the module.
    std::thread::spawn(move || {
        let mut said = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !said && let Some(address) = crate::module_transport::listening_address(&line) {
                said = true;
                let _ = heard.send(address);
            }
        }
    });
    let mut started = Started { child, socket };
    match listened.recv_timeout(START_TIMEOUT) {
        Ok(address) => Ok((address, started)),
        Err(_) => {
            let _ = started.child.kill();
            let _ = started.child.wait();
            Err(format!("{label} did not print \"listening <port>\" or \"listening unix:<socket>\" within {}s", START_TIMEOUT.as_secs()))
        }
    }
}
