//! A module host serving the notes adapter and the shout plugins:
//! `PORT=0 notes-module-host` prints `listening <port>`;
//! `notes-module-host --socket /tmp/notes.sock` listens on a Unix socket.

fn main() {
    if let Err(message) = rust_module_example::host(rust_module_example::Notes::default()).run(std::env::args().skip(1)) {
        eprintln!("notes-module-host: {message}");
        std::process::exit(1);
    }
}
