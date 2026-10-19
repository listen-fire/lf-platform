//! Local module processes (Henry 2026-10-19, "local module processes"): a
//! module's process starts the first time a run or a check needs it, stays
//! up while it is used, and stops after an idle period; one that crashed
//! starts again on its next use. Trusted modules (first-party `@lf/*`, or
//! `trusted: true` in their install) share one Node host, each under its own
//! path; any other module gets a process of its own, never shared.
//!
//! Transport-agnostic on purpose: a host is started from a `Launch` and
//! answers with its address; how that address is learned (`spawn`) is the
//! one place that knows the transport.
//!
//! Every started process is told to exit with lf (`LF_EXIT_WITH_PARENT`:
//! lf holds its stdin), and is recorded through the store slot so the next
//! lf on the same machine stops what a killed lf left behind (`track_in`).

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::backend::RunHostStore;
use crate::json::Js;

/// How long a module process may sit unused before lf stops it, when
/// lf.yaml's `moduleIdleTimeout` names no other.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// How long one protocol call may take, when lf.yaml's `callTimeout` names
/// no other: high, since a module call may wait on a slow provider or a model.
pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(600);

static IDLE_TIMEOUT_MS: AtomicU64 = AtomicU64::new(DEFAULT_IDLE_TIMEOUT.as_millis() as u64);
static CALL_TIMEOUT_MS: AtomicU64 = AtomicU64::new(DEFAULT_CALL_TIMEOUT.as_millis() as u64);

pub fn configure(idle_timeout: Duration, call_timeout: Duration) {
    IDLE_TIMEOUT_MS.store(idle_timeout.as_millis() as u64, Ordering::Relaxed);
    CALL_TIMEOUT_MS.store(call_timeout.as_millis() as u64, Ordering::Relaxed);
}

pub fn call_timeout() -> Duration {
    Duration::from_millis(CALL_TIMEOUT_MS.load(Ordering::Relaxed))
}

fn idle_timeout() -> Duration {
    Duration::from_millis(IDLE_TIMEOUT_MS.load(Ordering::Relaxed))
}

/// What starts a process: its command line, folder and whole environment.
#[derive(Clone, Debug, PartialEq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub dir: PathBuf,
    pub env: Vec<(String, String)>,
    /// How long it has to say where it answers.
    pub start_timeout: Duration,
}

/// A trusted module in the shared host: served under `/<path>/`, loaded
/// from `module` in `dir`, with its own MODULE_* settings.
#[derive(Clone, Debug, PartialEq)]
pub struct Mount {
    pub path: String,
    pub module: String,
    pub dir: PathBuf,
    pub env: BTreeMap<String, String>,
}

/// The settings serve-module reads per module (its `moduleOptionsOf`): only
/// a module whose install sets nothing else can share a process, since
/// anything else would be the whole process's environment.
pub const PER_MODULE_ENV: &[&str] = &["MODULE_TOKEN", "MODULE_BASE_URL_OVERRIDE", "MODULE_STATE_DIR", "MODULE_CONSTRUCTION_ARGS", "MODULE_PUBLIC_URL"];

/// A mount path is one URL path segment.
pub fn is_mount_path(path: &str) -> bool {
    let mut bytes = path.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphanumeric()) && bytes.all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum HostKey {
    Shared,
    Own(String),
}

struct Host {
    key: HostKey,
    /// Serialises starts: one start at a time, and a lease waits for it.
    starting: tokio::sync::Mutex<()>,
    state: Mutex<HostState>,
}

struct HostState {
    /// For the shared host, the serve-module command without a module; its
    /// mounts are added when it starts.
    launch: Launch,
    running: Option<Running>,
    in_flight: usize,
    last_used: Instant,
    /// Bumped on each start, so a stale idle timer leaves a newer process be.
    generation: u64,
}

struct Running {
    /// Killed when dropped.
    _child: Child,
    child_id: Option<u32>,
    address: String,
    /// The shared host's mounts when it started.
    mounts: Vec<String>,
    exited: Arc<Mutex<Option<String>>>,
}

#[derive(Default)]
struct Pool {
    hosts: HashMap<HostKey, Arc<Host>>,
    /// Every trusted module registered for the shared host, by path.
    mounts: BTreeMap<String, Mount>,
}

static POOL: LazyLock<Mutex<Pool>> = LazyLock::new(|| Mutex::new(Pool::default()));

fn pool() -> std::sync::MutexGuard<'static, Pool> {
    POOL.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// One module's way to its process. Cloning it shares the process.
#[derive(Clone)]
pub struct ModuleProcess {
    host: Arc<Host>,
    /// Where in the shared host it is served; None for a process of its own.
    mount: Option<String>,
    /// How errors name it.
    label: String,
}

impl ModuleProcess {
    /// A process of its own, started by `launch`. A different launch for the
    /// same module (its install changed) stops the old process.
    pub fn isolated(name: &str, launch: Launch) -> ModuleProcess {
        let host = host_for(HostKey::Own(name.to_string()), launch);
        ModuleProcess { host, mount: None, label: format!("external \"{name}\"") }
    }

    /// A place in the shared host, started by `base` (serve-module with no
    /// module named) with every registered mount.
    pub fn shared(mount: Mount, base: Launch) -> ModuleProcess {
        let path = mount.path.clone();
        let label = format!("external \"{path}\"");
        pool().mounts.insert(path.clone(), mount);
        let host = host_for(HostKey::Shared, base);
        ModuleProcess { host, mount: Some(path), label }
    }

    /// Its address for one call: the process started (or started again,
    /// after a crash, an idle stop, or a mount it lacks), and kept from an
    /// idle stop until the lease is dropped.
    pub async fn lease(&self) -> Result<Lease, String> {
        let _starting = self.host.starting.lock().await;
        let launch = {
            let mut state = lock(&self.host.state);
            if let Some(running) = &state.running {
                let crashed = lock(&running.exited).clone();
                if let Some(status) = crashed {
                    eprintln!("lf: {} exited ({status}); starting it again", self.host_label());
                    state.running = None;
                }
            }
            if let Some(running) = &state.running {
                if self.mount.as_ref().is_none_or(|m| running.mounts.contains(m)) {
                    let address = joined(&running.address, self.mount.as_deref());
                    state.in_flight += 1;
                    state.last_used = Instant::now();
                    return Ok(Lease { address, host: Some(self.host.clone()) });
                }
                // A trusted module joined after the shared host started: it
                // starts again with every mount.
                state.running = None;
            }
            state.launch.clone()
        };
        let (launch, mounts) = match self.host.key {
            HostKey::Shared => with_mounts(launch)?,
            HostKey::Own(_) => (launch, Vec::new()),
        };
        let started = spawn(&self.host_label(), &launch).await?;
        record(started.child_id, &launch);
        let mut state = lock(&self.host.state);
        state.generation += 1;
        state.in_flight += 1;
        state.last_used = Instant::now();
        let address = joined(&started.address, self.mount.as_deref());
        state.running = Some(Running { mounts, ..started });
        stop_when_idle(self.host.clone(), state.generation);
        Ok(Lease { address, host: Some(self.host.clone()) })
    }

    fn host_label(&self) -> String {
        match &self.host.key {
            HostKey::Shared => "the shared module host".to_string(),
            HostKey::Own(_) => self.label.clone(),
        }
    }
}

fn host_for(key: HostKey, launch: Launch) -> Arc<Host> {
    let mut pool = pool();
    if let Some(host) = pool.hosts.get(&key) {
        let mut state = lock(&host.state);
        if state.launch != launch {
            state.launch = launch;
            state.running = None;
        }
        return host.clone();
    }
    let host = Arc::new(Host {
        key: key.clone(),
        starting: tokio::sync::Mutex::new(()),
        state: Mutex::new(HostState { launch, running: None, in_flight: 0, last_used: Instant::now(), generation: 0 }),
    });
    pool.hosts.insert(key, host.clone());
    host
}

/// The shared host's launch with every registered mount (`MODULE_MOUNTS`).
fn with_mounts(mut launch: Launch) -> Result<(Launch, Vec<String>), String> {
    let mounts: Vec<Mount> = pool().mounts.values().cloned().collect();
    let json = Js::Arr(
        mounts
            .iter()
            .map(|m| {
                Js::Obj(crate::obj! {
                    "path" => Js::str(&m.path),
                    "module" => Js::str(&m.module),
                    "cwd" => Js::Str(m.dir.display().to_string()),
                    "env" => Js::Obj(m.env.iter().map(|(k, v)| (k.clone(), Js::str(v))).collect()),
                })
            })
            .collect(),
    );
    launch.env.push(("MODULE_MOUNTS".into(), json.to_json()));
    Ok((launch, mounts.into_iter().map(|m| m.path).collect()))
}

fn joined(address: &str, mount: Option<&str>) -> String {
    match mount {
        Some(path) => format!("{}/{path}/", address.trim_end_matches('/')),
        None => address.to_string(),
    }
}

/// An address held for one call.
pub struct Lease {
    pub address: String,
    host: Option<Arc<Host>>,
}

impl Lease {
    /// An address lf does not manage (a module that is only a manifest).
    pub fn remote(url: &str) -> Lease {
        Lease { address: url.to_string(), host: None }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(host) = &self.host {
            let mut state = lock(&host.state);
            state.in_flight = state.in_flight.saturating_sub(1);
            state.last_used = Instant::now();
        }
    }
}

/// Stops the host once nothing has used it for the idle period.
fn stop_when_idle(host: Arc<Host>, generation: u64) {
    tokio::spawn(async move {
        let mut wait = idle_timeout();
        loop {
            tokio::time::sleep(wait).await;
            let mut state = lock(&host.state);
            if state.generation != generation || state.running.is_none() {
                return;
            }
            let idle = idle_timeout();
            let unused = state.last_used.elapsed();
            if state.in_flight == 0 && unused >= idle {
                state.running = None;
                return;
            }
            wait = idle.saturating_sub(unused).max(Duration::from_millis(100));
        }
    });
}

/// Stops every module process (lf is exiting).
pub fn stop_all() {
    let hosts: Vec<Arc<Host>> = pool().hosts.values().cloned().collect();
    for host in hosts {
        lock(&host.state).running = None;
    }
}

/// Start `launch` and learn where it answers: it prints `listening <port>`.
async fn spawn(label: &str, launch: &Launch) -> Result<Running, String> {
    let mut child = Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&launch.dir)
        .env_clear()
        .envs(launch.env.iter().map(|(k, v)| (k, v)))
        .env("LF_EXIT_WITH_PARENT", "1")
        // lf holds its stdin: its end closing tells the process lf is gone.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{label}: {} could not be started ({e})", launch.program))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let waited = launch.start_timeout;
    let port = tokio::time::timeout(waited, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(port) = listening_port(&line) {
                return Ok(port);
            }
        }
        Err(format!("{label} exited before listening"))
    })
    .await
    .map_err(|_| {
        format!("{label} did not print \"listening <port>\" within {}s (lf.yaml's `startTimeout`, or --start-timeout, waits longer)", waited.as_secs())
    })??;
    // Keep reading what it prints, so a full pipe never blocks it; its
    // stdout ending is it gone, and the next lease starts it again.
    let exited = Arc::new(Mutex::new(None));
    let noticed = exited.clone();
    tokio::spawn(async move {
        while let Ok(Some(_)) = lines.next_line().await {}
        *lock(&noticed) = Some("its output closed".to_string());
    });
    let child_id = child.id();
    Ok(Running { _child: child, child_id, address: format!("http://127.0.0.1:{port}/"), mounts: Vec::new(), exited })
}

/// The port in a line `listening <port>…`.
pub fn listening_port(line: &str) -> Option<u16> {
    let digits: String = line.strip_prefix("listening ")?.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// A declared runtime (`runtime: node 22`): the program and the lowest
/// major version it must be.
pub fn check_runtime(external: &str, declared: &str) -> Result<(), String> {
    thread_local! {
        /// Each program's `--version`, asked once.
        static VERSIONS: RefCell<HashMap<String, Result<String, String>>> = RefCell::new(HashMap::new());
    }
    let malformed = || format!("external \"{external}\": runtime \"{declared}\" is not `<program> <major version>`, e.g. `node 22`");
    let mut words = declared.split_whitespace();
    let (Some(program), Some(version), None) = (words.next(), words.next(), words.next()) else { return Err(malformed()) };
    let wanted = leading_number(version).ok_or_else(malformed)?;
    let found = VERSIONS.with(|versions| {
        versions
            .borrow_mut()
            .entry(program.to_string())
            .or_insert_with(|| {
                std::process::Command::new(program)
                    .arg("--version")
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output()
                    .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                    .map_err(|_| format!("`{program}` is not installed (not on PATH)"))
            })
            .clone()
    });
    match found {
        Ok(text) => compare_runtime(external, declared, program, wanted, &text),
        Err(missing) => Err(format!("external \"{external}\" runs on {declared}, but {missing}")),
    }
}

fn compare_runtime(external: &str, declared: &str, program: &str, wanted: u64, version_text: &str) -> Result<(), String> {
    match version_text.split(|c: char| !c.is_ascii_digit()).find(|part| !part.is_empty()).and_then(leading_number) {
        Some(major) if major >= wanted => Ok(()),
        Some(_) => Err(format!("external \"{external}\" runs on {declared}, but `{program} --version` is {version_text}: install {program} {wanted} or newer")),
        None => Err(format!("external \"{external}\" runs on {declared}, but `{program} --version` printed no version (\"{version_text}\")")),
    }
}

fn leading_number(text: &str) -> Option<u64> {
    let digits: String = text.trim_start_matches(['v', '>', '=']).chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

// --- Leftovers, tracked through the store slot --------------------------

/// The store row the started processes are listed in.
const PROCESSES_KEY: &str = "lf:module-processes";

thread_local! {
    static TRACKER: RefCell<Option<Rc<dyn RunHostStore>>> = const { RefCell::new(None) };
}

#[derive(Clone, Debug, PartialEq)]
struct Record {
    pid: u32,
    /// The lf that started it.
    lf: u32,
    machine: String,
    command: String,
}

impl Record {
    fn to_js(&self) -> Js {
        Js::Obj(crate::obj! {
            "pid" => Js::Num(self.pid.into()),
            "lf" => Js::Num(self.lf.into()),
            "machine" => Js::str(&self.machine),
            "command" => Js::str(&self.command),
        })
    }

    fn of(value: &Js) -> Option<Record> {
        let number = |k: &str| value.get(k).and_then(|v| if let Js::Num(n) = v { n.as_u64() } else { None }).and_then(|n| u32::try_from(n).ok());
        let text = |k: &str| value.get(k).and_then(Js::as_str).map(str::to_string);
        Some(Record { pid: number("pid")?, lf: number("lf")?, machine: text("machine")?, command: text("command")? })
    }
}

fn records(store: &dyn RunHostStore) -> Vec<Record> {
    let row = store.inbound_checkpoint(PROCESSES_KEY).ok().flatten();
    row.as_ref().and_then(|r| r.get("processes")).and_then(Js::as_array).into_iter().flatten().filter_map(Record::of).collect()
}

fn save(store: &dyn RunHostStore, kept: &[Record]) {
    let row = Js::Obj(crate::obj! { "processes" => Js::Arr(kept.iter().map(Record::to_js).collect()) });
    if let Err(e) = store.save_inbound_checkpoint(PROCESSES_KEY, &row) {
        eprintln!("lf: the store did not keep the module process list ({e})");
    }
}

/// Stops the module processes an lf on this machine started and left
/// behind (it was killed before it could stop them), then lists the ones
/// this lf starts in `store`.
pub fn track_in(store: Rc<dyn RunHostStore>) {
    let (me, here) = (std::process::id(), machine());
    let mut kept = Vec::new();
    for record in records(&*store) {
        let ours = record.machine == here;
        if !ours || record.lf == me || alive(record.lf) {
            kept.push(record);
            continue;
        }
        if alive(record.pid) && command_of(record.pid).is_some_and(|c| c.contains(&record.command)) {
            eprintln!("lf: stopping a module process an earlier lf left running (pid {}, {})", record.pid, record.command);
            terminate(record.pid);
        }
    }
    save(&*store, &kept);
    TRACKER.with(|t| *t.borrow_mut() = Some(store));
}

fn record(pid: Option<u32>, launch: &Launch) {
    let Some(pid) = pid else { return };
    let Some(store) = TRACKER.with(|t| t.borrow().clone()) else { return };
    let (me, here) = (std::process::id(), machine());
    let mut kept: Vec<Record> = records(&*store).into_iter().filter(|r| !(r.machine == here && r.lf == me && !alive(r.pid))).collect();
    kept.push(Record { pid, lf: me, machine: here, command: launch.program.clone() });
    save(&*store, &kept);
}

fn machine() -> String {
    static NAME: LazyLock<String> = LazyLock::new(|| {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "localhost".into())
    });
    NAME.clone()
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    std::process::Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

#[cfg(unix)]
fn command_of(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(unix)]
fn terminate(pid: u32) {
    let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).stderr(Stdio::null()).status();
}

#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    false
}

#[cfg(not(unix))]
fn command_of(_pid: u32) -> Option<String> {
    None
}

#[cfg(not(unix))]
fn terminate(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_read_off_the_listening_line() {
        assert_eq!(listening_port("listening 5557"), Some(5557));
        assert_eq!(listening_port("listening 80 on all"), Some(80));
        assert_eq!(listening_port("ready"), None);
    }

    #[test]
    fn a_mount_is_one_path_segment_under_the_hosts_address() {
        assert!(is_mount_path("attio") && is_mount_path("acme_crm") && is_mount_path("a.b-c"));
        assert!(!is_mount_path("") && !is_mount_path("a/b") && !is_mount_path("-a") && !is_mount_path("@lf"));
        assert_eq!(joined("http://127.0.0.1:9/", Some("attio")), "http://127.0.0.1:9/attio/");
        assert_eq!(joined("http://127.0.0.1:9/", None), "http://127.0.0.1:9/");
    }

    #[test]
    fn a_runtime_is_a_program_and_its_lowest_major_version() {
        assert_eq!(compare_runtime("m", "node 22", "node", 22, "v22.20.0"), Ok(()));
        assert_eq!(compare_runtime("m", "node 22", "node", 22, "v24.1.0"), Ok(()));
        let old = compare_runtime("m", "node 22", "node", 22, "v20.11.1").unwrap_err();
        assert!(old.contains("external \"m\" runs on node 22") && old.contains("v20.11.1"), "{old}");
        assert!(check_runtime("m", "node").unwrap_err().contains("<program> <major version>"));
        let missing = check_runtime("m", "lf-no-such-runtime-xyz 3").unwrap_err();
        assert!(missing.contains("`lf-no-such-runtime-xyz` is not installed"), "{missing}");
    }

    #[test]
    fn a_record_round_trips_through_the_store_row() {
        let record = Record { pid: 7, lf: 3, machine: "box".into(), command: "node".into() };
        assert_eq!(Record::of(&record.to_js()), Some(record));
    }

    fn sh(script: &str) -> Launch {
        Launch {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            dir: std::env::temp_dir(),
            env: vec![("PATH".into(), std::env::var("PATH").unwrap_or_default())],
            start_timeout: Duration::from_secs(10),
        }
    }

    #[tokio::test]
    async fn a_process_starts_on_first_use_and_again_after_it_crashed() {
        // Prints a port it never serves, then exits when told to (a crash).
        let name = format!("crash-{}", uuid::Uuid::new_v4());
        let process = ModuleProcess::isolated(&name, sh("echo listening 1; echo $$ > /dev/null; sleep 0.2"));
        assert!(lock(&process.host.state).running.is_none(), "nothing starts before it is needed");
        let first = process.lease().await.unwrap();
        assert_eq!(first.address, "http://127.0.0.1:1/");
        drop(first);
        let first_id = lock(&process.host.state).running.as_ref().and_then(|r| r.child_id);
        tokio::time::sleep(Duration::from_millis(600)).await;
        let _second = process.lease().await.unwrap();
        let second_id = lock(&process.host.state).running.as_ref().and_then(|r| r.child_id);
        assert_ne!(first_id, second_id, "the crashed process was started again");
    }

    #[tokio::test]
    async fn an_idle_process_is_stopped_and_a_leased_one_is_not() {
        let name = format!("idle-{}", uuid::Uuid::new_v4());
        let process = ModuleProcess::isolated(&name, sh("echo listening 2; sleep 30"));
        configure(Duration::from_millis(200), DEFAULT_CALL_TIMEOUT);
        let held = process.lease().await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(lock(&process.host.state).running.is_some(), "a lease keeps it up");
        drop(held);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(lock(&process.host.state).running.is_none(), "idle, it was stopped");
        configure(DEFAULT_IDLE_TIMEOUT, DEFAULT_CALL_TIMEOUT);
    }
}
