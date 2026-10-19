//! Write a listen-fire module in Rust and serve it over adapter protocol 2.
//!
//! A module is one kind, with one trait:
//!
//! - [`Adapter`]: a system a movement connects to, reads and writes.
//! - [`Plugins`]: a package of functions a movement calls.
//! - A core slot: [`Store`] (run state), [`Limiter`] (provider limits),
//!   [`LoopGuard`] (a movement's own write coming back).
//!
//! A [`Host`] serves one or several modules, each at `/<name>`, over HTTP on
//! loopback TCP or a Unix socket. It is its own process: lf speaks to it as
//! to any module server, never linking it in. Trusted modules may share a
//! host; an untrusted one gets a host of its own.
//!
//! ```no_run
//! use module_kit::*;
//!
//! struct Notes;
//! impl Adapter for Notes {
//!     fn manifest(&self) -> AdapterManifest {
//!         AdapterManifest::new("notes")
//!     }
//!     async fn list_entry_points(&self, _: &Ctx) -> Answer<Vec<EntryPoint>> {
//!         Ok(vec![])
//!     }
//!     async fn describe(&self, _: &Ctx, _: Describe) -> Answer<Option<TypeDescriptor>> {
//!         Ok(None)
//!     }
//! }
//!
//! fn main() -> Result<(), String> {
//!     Host::new().adapter(Notes).run(std::env::args().skip(1))
//! }
//! ```
//!
//! Every method is async and runs on the host's one thread, so a module's
//! futures need not be `Send`.

pub mod adapter;
pub mod context;
pub mod core;
pub mod host;
pub mod module;
pub mod plugin;

pub use adapter::*;
pub use context::{Answer, Ctx, ModuleError, from_js, to_js};
pub use core::{Limiter, LoopGuard, Store};
pub use host::{Address, Host, Listener};
pub use module::Module;
pub use module_wire::json::{Js, Obj};
pub use module_wire::obj;
pub use plugin::*;
