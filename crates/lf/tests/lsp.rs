//! `lf lsp` end to end: the binary driven over stdio as an editor drives it —
//! initialize, didOpen, the published diagnostics, completion, hover,
//! definition, a code action, shutdown and exit.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Client {
    fn send(&mut self, message: Value) {
        let body = serde_json::to_vec(&message).unwrap();
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.stdin.write_all(&body).unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut length = 0;
        loop {
            let mut header = String::new();
            assert!(self.stdout.read_line(&mut header).unwrap() > 0, "lf lsp closed its output");
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some(n) = header.strip_prefix("Content-Length:") {
                length = n.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        self.stdout.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// Sends a request and answers its result, skipping notifications.
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let message = self.receive();
            if message.get("id") == Some(&json!(id)) {
                assert!(message.get("error").is_none(), "{message}");
                return message["result"].clone();
            }
        }
    }

    fn notification(&mut self, method: &str) -> Value {
        loop {
            let message = self.receive();
            if message.get("method").and_then(Value::as_str) == Some(method) {
                return message["params"].clone();
            }
        }
    }
}

const SOURCE: &str = "function hello(run: <manual-[:Invocation]->>) {
  shout = UPPER(run.`Text`)
  return \"Hello, ${shout}!\"
}

listen to manual fire hello
";

#[test]
fn an_editor_session_over_stdio() {
    let dir = std::env::temp_dir().join(format!("lf-lsp-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let lf = env!("CARGO_BIN_EXE_lf");
    assert!(Command::new(lf).arg("init").arg(&dir).output().unwrap().status.success());
    let file = dir.join("movements/hello.mvt");
    std::fs::write(&file, SOURCE).unwrap();
    let uri = format!("file://{}", file.display());

    let mut child = Command::new(lf).arg("lsp").arg("--dir").arg(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let (stdin, stdout) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
    let mut client = Client { child, stdin, stdout, next_id: 0 };

    let init = client.request("initialize", json!({ "processId": null, "rootUri": format!("file://{}", dir.display()), "capabilities": {} }));
    assert_eq!(init.pointer("/capabilities/hoverProvider"), Some(&json!(true)));
    client.notify("initialized", json!({}));
    client.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "movement", "version": 1, "text": SOURCE } }));

    let published = client.notification("textDocument/publishDiagnostics");
    assert_eq!(published["uri"], json!(uri));
    let diagnostics = published["diagnostics"].as_array().unwrap();
    let spelling = diagnostics.iter().find(|d| d["code"] == "MOV_V5_SPELLING").unwrap_or_else(|| panic!("{published}"));

    // `run.` on line 1: the manual unit's fields.
    let completion = client.request("textDocument/completion", json!({ "textDocument": { "uri": uri }, "position": { "line": 1, "character": 20 } }));
    let labels: Vec<&str> = completion["items"].as_array().unwrap().iter().map(|i| i["label"].as_str().unwrap()).collect();
    assert!(labels.contains(&"Text") && labels.contains(&"Run by (name)"), "{labels:?}");

    // `shout` on line 2: its type.
    let hover = client.request("textDocument/hover", json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 21 } }));
    let contents = hover.pointer("/contents/value").and_then(Value::as_str).unwrap_or_else(|| panic!("{hover}"));
    assert!(contents.contains("shout: text") && contents.contains(&format!("{}/", movement_language::docs_base())), "{contents}");

    // `hello` in the listen: the function's declaration.
    let definition = client.request("textDocument/definition", json!({ "textDocument": { "uri": uri }, "position": { "line": 5, "character": 24 } }));
    assert_eq!(definition["uri"], json!(uri));
    assert_eq!(definition.pointer("/range/start"), Some(&json!({ "line": 0, "character": 9 })));

    let actions = client.request("textDocument/codeAction", json!({ "textDocument": { "uri": uri }, "range": spelling["range"], "context": { "diagnostics": [spelling] } }));
    let edits = actions[0].pointer(&format!("/edit/changes/{}", uri.replace('~', "~0").replace('/', "~1"))).unwrap_or_else(|| panic!("{actions}"));
    assert!(edits.as_array().unwrap().iter().any(|e| e["newText"].as_str().unwrap().contains("Text.upper")), "{actions}");

    // An edit that fixes it publishes again, after the debounce, without it.
    let fixed = SOURCE.replace("UPPER(", "Text.upper(");
    client.notify("textDocument/didChange", json!({ "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": fixed }] }));
    let published = client.notification("textDocument/publishDiagnostics");
    assert!(!published["diagnostics"].as_array().unwrap().iter().any(|d| d["code"] == "MOV_V5_SPELLING"), "{published}");

    assert_eq!(client.request("shutdown", Value::Null), Value::Null);
    client.notify("exit", Value::Null);
    let status = client.child.wait().unwrap();
    assert!(status.success());
    let _ = std::fs::remove_dir_all(&dir);
}

/// The example module host (examples/rust-module) on a loopback port of its own thread; its port.
fn serve_notes() -> u16 {
    let (sent, port) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async move {
            let listener = module_kit::Listener::bind(&module_kit::Address::Tcp(([127, 0, 0, 1], 0).into())).await.unwrap();
            sent.send(listener.address().parse::<u16>().unwrap()).unwrap();
            rust_module_example::host(rust_module_example::Notes::default()).serve(listener).await.unwrap();
        });
    });
    port.recv().unwrap()
}

const NOTES_SOURCE: &str = "import { notes } from adapters

n = connect notes

function title(note: <n-[:Note]->>) {
  return note.Title
}

listen to n { events: [\"note.created\"] } fire title
";

#[test]
fn a_save_reads_the_catalog_again() {
    let dir = std::env::temp_dir().join(format!("lf-lsp-save-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let lf = env!("CARGO_BIN_EXE_lf");
    assert!(Command::new(lf).arg("init").arg(&dir).output().unwrap().status.success());
    std::fs::remove_file(dir.join("movements/hello.mvt")).unwrap();
    let file = dir.join("movements/notes.mvt");
    std::fs::write(&file, NOTES_SOURCE).unwrap();
    let uri = format!("file://{}", file.display());

    let mut child = Command::new(lf).arg("lsp").arg("--dir").arg(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let (stdin, stdout) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
    let mut client = Client { child, stdin, stdout, next_id: 0 };
    let init = client.request("initialize", json!({ "processId": null, "rootUri": format!("file://{}", dir.display()), "capabilities": {} }));
    assert_eq!(init.pointer("/capabilities/textDocumentSync/save"), Some(&json!({ "includeText": false })));
    client.notify("initialized", json!({}));
    client.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "movement", "version": 1, "text": NOTES_SOURCE } }));
    let errors = |published: &Value| published["diagnostics"].as_array().unwrap().iter().filter(|d| d["severity"] == 1).cloned().collect::<Vec<_>>();
    let before = client.notification("textDocument/publishDiagnostics");
    assert!(!errors(&before).is_empty(), "with no notes module installed, the file does not check: {before}");

    // The module is installed while the server runs; saving reads it.
    let port = serve_notes();
    std::fs::create_dir_all(dir.join("externals/notes")).unwrap();
    std::fs::write(dir.join("externals/notes/lf-external.yaml"), format!("name: notes\nkind: adapter\nprotocol: 2\nurl: http://127.0.0.1:{port}/notes\n")).unwrap();
    client.notify("textDocument/didSave", json!({ "textDocument": { "uri": uri } }));
    let after = client.notification("textDocument/publishDiagnostics");
    assert!(errors(&after).is_empty(), "after the save the notes module's catalog is read: {after}");

    assert_eq!(client.request("shutdown", Value::Null), Value::Null);
    client.notify("exit", Value::Null);
    assert!(client.child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Not a test of its own: the notes adapter as a module process, when lf
/// starts this test binary as an external's `command` (the next test).
#[test]
fn notes_module_process() {
    let Ok(pid_file) = std::env::var("LF_TEST_NOTES_PID_FILE") else { return };
    std::fs::write(pid_file, std::process::id().to_string()).unwrap();
    // Ends the harness's `test notes_module_process ... ` line, so the host's
    // `listening <port>` is a line of its own.
    println!();
    module_kit::Host::new().adapter(rust_module_example::Notes::default()).run(Vec::<String>::new()).unwrap();
}

#[test]
fn a_module_that_ends_is_started_again_and_its_catalog_read() {
    let dir = std::env::temp_dir().join(format!("lf-lsp-restart-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let lf = env!("CARGO_BIN_EXE_lf");
    assert!(Command::new(lf).arg("init").arg(&dir).output().unwrap().status.success());
    std::fs::remove_file(dir.join("movements/hello.mvt")).unwrap();
    let file = dir.join("movements/notes.mvt");
    std::fs::write(&file, NOTES_SOURCE).unwrap();
    let uri = format!("file://{}", file.display());
    let pid_file = dir.join("notes.pid");
    let me = std::env::current_exe().unwrap();
    std::fs::create_dir_all(dir.join("externals/notes")).unwrap();
    std::fs::write(
        dir.join("externals/notes/lf-external.yaml"),
        format!(
            "name: notes\nkind: adapter\nprotocol: 2\ncommand: [{:?}, \"--exact\", \"notes_module_process\", \"--nocapture\", \"--test-threads\", \"1\"]\nenv:\n  LF_TEST_NOTES_PID_FILE: {:?}\n",
            me.display().to_string(),
            pid_file.display().to_string()
        ),
    )
    .unwrap();

    let mut child = Command::new(lf).arg("lsp").arg("--dir").arg(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let (stdin, stdout) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
    let mut client = Client { child, stdin, stdout, next_id: 0 };
    client.request("initialize", json!({ "processId": null, "rootUri": format!("file://{}", dir.display()), "capabilities": {} }));
    client.notify("initialized", json!({}));
    client.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "movement", "version": 1, "text": NOTES_SOURCE } }));
    let errors = |published: &Value| published["diagnostics"].as_array().unwrap().iter().filter(|d| d["severity"] == 1).cloned().collect::<Vec<_>>();
    let first = client.notification("textDocument/publishDiagnostics");
    assert!(errors(&first).is_empty(), "the module lf started was read: {first}");
    let first_pid = std::fs::read_to_string(&pid_file).unwrap();

    // The module ends on its own: unasked, the server reads the catalog
    // again (publishing the open file once more), which starts it again.
    assert!(Command::new("kill").arg(&first_pid).status().unwrap().success());
    let again = client.notification("textDocument/publishDiagnostics");
    assert!(errors(&again).is_empty(), "{again}");
    let second_pid = std::fs::read_to_string(&pid_file).unwrap();
    assert_ne!(first_pid, second_pid, "the module was started again");

    assert_eq!(client.request("shutdown", Value::Null), Value::Null);
    client.notify("exit", Value::Null);
    assert!(client.child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(&dir);
}
