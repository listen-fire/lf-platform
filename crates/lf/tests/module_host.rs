//! Crate modules served by a module host (crates/module-kit), driven by the
//! real `lf` as externals reached by url: one host, an adapter at `/notes`
//! and a plugin package at `/shout`. lf checks a movement against them and
//! runs it on an event: the plugin's answer is written through the adapter.

use std::path::PathBuf;
use std::process::Command;

use rust_module_example::Notes;

/// The example host on a loopback port of its own thread; its port.
fn serve(notes: Notes) -> u16 {
    let (sent, port) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async move {
            let listener = module_kit::Listener::bind(&module_kit::Address::Tcp(([127, 0, 0, 1], 0).into())).await.unwrap();
            sent.send(listener.address().parse::<u16>().unwrap()).unwrap();
            rust_module_example::host(notes).serve(listener).await.unwrap();
        });
    });
    port.recv().unwrap()
}

struct Project(PathBuf);

impl Project {
    fn new(port: u16) -> Project {
        let root = std::env::temp_dir().join(format!("lf-module-host-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        assert!(Command::new(env!("CARGO_BIN_EXE_lf")).arg("init").arg(&root).output().unwrap().status.success());
        std::fs::remove_file(root.join("movements/hello.mvt")).unwrap();
        for (name, kind) in [("notes", "adapter"), ("shout", "plugin")] {
            std::fs::create_dir_all(root.join("externals").join(name)).unwrap();
            std::fs::write(
                root.join("externals").join(name).join("lf-external.yaml"),
                format!("name: {name}\nkind: {kind}\nprotocol: 2\nurl: http://127.0.0.1:{port}/{name}\n"),
            )
            .unwrap();
        }
        std::fs::write(
            root.join("movements/reply.mvt"),
            "import { notes } from adapters\nimport { `@acme/shout` as shout } from plugins\n\nn = connect notes\n\n\
             function reply(note: <n-[:Note]->>) {\n  write n-[:Note]-> { Title: shout.shoutOut(note.Title) }\n}\n\n\
             listen to n { events: [\"note.created\"] } fire reply\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("events")).unwrap();
        std::fs::write(
            root.join("events/note.json"),
            r#"{ "external": "notes", "event": { "payload": { "id": "n-1", "Title": "hello" }, "externalId": "n-1",
                 "eventType": "note.created", "changeType": "create", "recordType": "Note" } }"#,
        )
        .unwrap();
        Project(root)
    }

    fn lf(&self, args: &[&str]) -> (i32, String) {
        let out = Command::new(env!("CARGO_BIN_EXE_lf")).args(args).current_dir(&self.0).output().unwrap();
        (out.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

#[test]
fn lf_checks_and_runs_a_movement_against_crate_modules_in_one_host() {
    let notes = Notes::default();
    let project = Project::new(serve(notes.clone()));

    let (code, out) = project.lf(&["check"]);
    assert_eq!(code, 0, "lf check: {out}");

    let (code, out) = project.lf(&["run", "--event", "events/note.json"]);
    assert_eq!(code, 0, "lf run: {out}");
    let written = notes.notes();
    assert_eq!(written.len(), 1, "one note written: {written:?}\n{out}");
    assert_eq!(written[0].1.get("Title").and_then(module_kit::Js::as_str), Some("HELLO"));
}
