//! `lf serve --doors-only` with a wake module in the project's wake slot,
//! both served by a module host (crates/module-kit) on a thread of the test:
//! a signed delivery to `/hooks/inbox` is queued, not run (202, the row
//! listed), and the wake module is told the work is ready now; nothing
//! drains in serve; a worker (`lf drain --until-idle`) runs the event, whose
//! movement parks on a timer, and the wake module is told the timer's work
//! is ready an hour later. A call to a callback's door is recorded, its body
//! queued for a worker rather than run in the request.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use hmac::{Hmac, KeyInit, Mac};
use module_kit::*;
use module_kit::core::{WakeAt, WakeNow};

const SECRET: &str = "s3cret";

/// An adapter whose deliveries are lists of notes: each one a `note.created` event.
struct Inbox;

impl Adapter for Inbox {
    fn manifest(&self) -> AdapterManifest {
        AdapterManifest::new("inbox").triggers(["webhook"]).optional(["listEventTypes", "preprocessInbound"]).declare("subscribableEvents", Js::strings(["note.created"]))
    }

    async fn list_entry_points(&self, _: &Ctx) -> Answer<Vec<EntryPoint>> {
        Ok(vec![EntryPoint { type_id: "Note".into(), display_name: "Note".into(), writable: false, readable: false, fires: Some(true), description: None, rest: Obj::new() }])
    }

    async fn describe(&self, _: &Ctx, request: Describe) -> Answer<Option<TypeDescriptor>> {
        Ok((request.type_id == "Note").then(|| TypeDescriptor {
            type_id: "Note".into(),
            display_name: "Note".into(),
            fields: vec![Field::new("Title", "string", true, true)],
            references: vec![],
            deletable: None,
            rest: Obj::new(),
        }))
    }

    async fn create_record(&self, _: &Ctx, _: CreateRecord) -> Answer<Written> {
        Err(ModuleError::bad_request("the inbox is read only"))
    }

    async fn update_record(&self, _: &Ctx, _: UpdateRecord) -> Answer<Option<Updated>> {
        Ok(None)
    }

    async fn optional(&self, _: &Ctx, method: &str, params: Js) -> Answer<Js> {
        match method {
            "listEventTypes" => Ok(Js::Arr(vec![Js::Obj(obj! { "tag" => Js::str("note.created"), "positionType" => Js::str("Note") })])),
            "preprocessInbound" => {
                let notes = params.get("raw").and_then(|raw| raw.get("notes")).and_then(Js::as_array).unwrap_or(&[]).to_vec();
                let events = notes
                    .iter()
                    .map(|note| {
                        let id = note.get("id").and_then(Js::as_str).unwrap_or_default();
                        Js::Obj(obj! {
                            "payload" => note.clone(),
                            "externalId" => Js::str(id),
                            "idempotencyKey" => Js::str(id),
                            "eventType" => Js::str("note.created"),
                            "changeType" => Js::str("create"),
                            "recordType" => Js::str("Note"),
                        })
                    })
                    .collect();
                Ok(Js::Obj(obj! { "events" => Js::Arr(events) }))
            }
            other => Err(ModuleError::not_implemented(other)),
        }
    }
}

/// A wake module that keeps what it was told: (`now` or the `at` instant, the work's kind).
#[derive(Clone, Default)]
struct Told(Arc<Mutex<Vec<(String, String)>>>);

impl Told {
    fn all(&self) -> Vec<(String, String)> {
        self.0.lock().unwrap().clone()
    }
}

impl Wake for Told {
    async fn now(&self, _: &Ctx, params: WakeNow) -> Answer<()> {
        self.0.lock().unwrap().push(("now".into(), params.kind));
        Ok(())
    }

    async fn at(&self, _: &Ctx, params: WakeAt) -> Answer<()> {
        self.0.lock().unwrap().push((params.at, params.kind));
        Ok(())
    }
}

/// The inbox at `/inbox` and the wake module at `/acme_wake`, on a loopback port of their own thread.
fn serve(told: Told) -> u16 {
    let (sent, port) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async move {
            let listener = Listener::bind(&Address::Tcp(([127, 0, 0, 1], 0).into())).await.unwrap();
            sent.send(listener.address().parse::<u16>().unwrap()).unwrap();
            Host::new().adapter(Inbox).wake("acme_wake", told).serve(listener).await.unwrap();
        });
    });
    port.recv().unwrap()
}

struct Project(PathBuf);

impl Project {
    fn new(name: &str, port: u16) -> Project {
        let root = std::env::temp_dir().join(format!("lf-doors-only-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        assert!(Command::new(env!("CARGO_BIN_EXE_lf")).arg("init").arg(&root).output().unwrap().status.success());
        std::fs::remove_file(root.join("movements/hello.mvt")).unwrap();
        let external = |name: &str, yaml: String| {
            std::fs::create_dir_all(root.join("externals").join(name)).unwrap();
            std::fs::write(root.join("externals").join(name).join("lf-external.yaml"), yaml).unwrap();
        };
        external("inbox", format!("name: inbox\nkind: adapter\nprotocol: 2\nurl: http://127.0.0.1:{port}/inbox\nwebhook:\n  signature: hmac-sha256\n  secretField: webhook_secret\n"));
        external("acme_wake", format!("name: acme_wake\nkind: core\nslot: wake\nurl: http://127.0.0.1:{port}/acme_wake\n"));
        let mut lf_yaml = std::fs::read_to_string(root.join("lf.yaml")).unwrap();
        lf_yaml.push_str("core:\n  wake: acme_wake\n");
        std::fs::write(root.join("lf.yaml"), lf_yaml).unwrap();
        std::fs::write(
            root.join("movements/later.mvt"),
            "import { inbox } from adapters\n\ni = connect inbox\n\n\
             function later(note: <i-[:Note]->>) {\n  await sleep(1h)\n}\n\n\
             listen to i { events: [\"note.created\"] } fire later\n",
        )
        .unwrap();
        Project(root)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_lf"));
        command.args(args).current_dir(&self.0).env("LF_SECRET__INBOX__EXTERNAL", "inbox").env("LF_SECRET__INBOX__WEBHOOK_SECRET", SECRET);
        command
    }

    fn lf(&self, args: &[&str]) -> (i32, String) {
        let out = self.command(args).output().unwrap();
        (out.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

/// `lf serve`, stopped when dropped.
struct Serving(Child);

impl Drop for Serving {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// `lf serve --doors-only` started, and the port it listens on.
fn serve_doors_only(project: &Project) -> (Serving, u16) {
    let mut child = project.command(&["serve", "--doors-only", "--port", "0"]).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let serving = Serving(child);
    for line in lines.by_ref() {
        let line = line.unwrap();
        if let Some(rest) = line.strip_prefix("lf serving on http://127.0.0.1:") {
            let port = rest.split('/').next().unwrap().parse().unwrap();
            // Keep reading its output so it never blocks on a full pipe.
            std::thread::spawn(move || lines.for_each(drop));
            return (serving, port);
        }
    }
    panic!("lf serve stopped before it listened");
}

/// One signed POST; the status and the body.
fn deliver(port: u16, body: &str) -> (u16, String) {
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(body.as_bytes());
    let signature: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
    post(port, "/hooks/inbox", &format!("x-listen-fire-signature: {signature}\r\n"), body)
}

/// One POST of a JSON body, with any extra header lines; the status and the body.
fn post(port: u16, path: &str, headers: &str, body: &str) -> (u16, String) {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let status = answer.split(' ').nth(1).unwrap().parse().unwrap();
    (status, answer.split("\r\n\r\n").nth(1).unwrap_or_default().to_string())
}

fn epoch_ms(iso: &str) -> i64 {
    iso.parse::<jiff::Timestamp>().unwrap().as_millisecond()
}

#[test]
fn serve_doors_only_queues_a_delivery_and_the_wake_module_hears_of_each_queued_row() {
    let told = Told::default();
    let project = Project::new("hooks", serve(told.clone()));
    let (code, out) = project.lf(&["check"]);
    assert_eq!(code, 0, "lf check: {out}");

    let (serving, port) = serve_doors_only(&project);
    let (status, body) = deliver(port, r#"{"notes":[{"id":"n-1","Title":"hello"}]}"#);
    assert_eq!(status, 202, "{body}");
    let answer: serde_json::Value = serde_json::from_str(&body).unwrap();
    let queued = answer["queued"].as_array().unwrap();
    assert_eq!(queued.len(), 1, "{body}");
    assert_eq!((queued[0]["kind"].as_str(), queued[0]["external"].as_str()), (Some("fire_event"), Some("inbox")));
    assert!(answer.get("runs").is_none(), "nothing ran in the request: {body}");
    assert_eq!(told.all(), vec![("now".to_string(), "fire_event".to_string())]);

    // Past serve's drain tick: had it drained, the run would be there.
    std::thread::sleep(std::time::Duration::from_millis(2_500));
    let (code, out) = project.lf(&["runs", "--json"]);
    assert_eq!(code, 0, "lf runs: {out}");
    assert!(!out.contains("later"), "serve ran nothing: {out}");
    drop(serving);

    let (code, out) = project.lf(&["drain", "--until-idle"]);
    assert_eq!(code, 0, "lf drain: {out}");
    assert!(out.contains("parked"), "the worker ran the event to its timer: {out}");
    let told = told.all();
    let (at, _) = told.iter().find(|(_, kind)| kind == "resume_timer").unwrap_or_else(|| panic!("the timer's wake: {told:?}"));
    let in_an_hour = jiff::Timestamp::now().as_millisecond() + 3_600_000;
    assert!((epoch_ms(at) - in_an_hour).abs() < 300_000, "the timer is due in an hour, not at {at}");
}

#[test]
fn serve_doors_only_records_a_callbacks_call_and_queues_its_body_for_a_worker() {
    let told = Told::default();
    let project = Project::new("callback", serve(told.clone()));
    std::fs::write(
        project.0.join("movements/ask.mvt"),
        "function ask(run: <manual-[:Invocation]->>) {\n  question = callback((note: <text>) => {})\n  c = await first(question-[:Called]->)\n  return c.note\n}\n\nlisten to manual fire ask\n",
    )
    .unwrap();
    let (code, out) = project.lf(&["run", "ask", "--json"]);
    assert_eq!(code, 0, "lf run: {out}");
    let ran: serde_json::Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out}"));
    assert_eq!(ran["runs"][0]["status"], "parked", "{out}");
    let run_id = ran["runs"][0]["runId"].as_str().unwrap().to_string();
    let callback_id: String = rusqlite::Connection::open(project.0.join(".lf/state.db")).unwrap().query_row("select id from callback", [], |r| r.get(0)).unwrap();
    let status_of = |project: &Project| {
        let (code, out) = project.lf(&["runs", "show", &run_id, "--json"]);
        assert_eq!(code, 0, "lf runs show: {out}");
        let shown: serde_json::Value = serde_json::from_str(&out).unwrap();
        shown["run"]["status"].as_str().unwrap().to_string()
    };

    let (serving, port) = serve_doors_only(&project);
    let (status, body) = post(port, &format!("/api/cb/{callback_id}"), "", r#"{"note":"yes"}"#);
    assert_eq!(status, 202, "{body}");
    assert!(body.contains("\"recorded\""), "{body}");
    assert!(told.all().contains(&("now".to_string(), "fire_callback".to_string())), "the body's row is ready now: {:?}", told.all());
    // Past serve's drain tick: had it run the body, the run would have finished.
    std::thread::sleep(std::time::Duration::from_millis(2_500));
    assert_eq!(status_of(&project), "parked", "nothing ran in the request");
    drop(serving);

    let (code, out) = project.lf(&["drain", "--until-idle"]);
    assert_eq!(code, 0, "lf drain: {out}");
    assert_eq!(status_of(&project), "completed", "the worker ran the body and woke the await: {out}");
}
