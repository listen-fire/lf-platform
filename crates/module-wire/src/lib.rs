//! Adapter protocol 2 as both ends speak it (docs/contracts/adapter-protocol.md):
//! the host (`lf`) and a module served by the module kit
//! (`listen-fire-module-kit`).
//!
//! - [`json`]: JSON keeping JavaScript's key order, since a catalog built from
//!   a module's answers is read in that order.
//! - [`envelope`]: the envelope's constants and error wording.
//! - [`results`]: every method's result schema, checked as the TypeScript
//!   client checks it.

pub mod envelope;
pub mod json;
pub mod results;
