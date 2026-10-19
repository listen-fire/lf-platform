# listen-fire

Movements: a small language for automations that listen to a system and
write to others. This crate is the front door:

- `cargo install listen-fire` installs `lf`, which checks and runs a
  project's movements on your machine (docs/getting-started-lf.md in the
  repository).
- `cargo install listen-fire --no-default-features --features cli` installs a
  light `lf`: the SQLite store, local and `serve-module` modules, `check` and
  `run`, without the Anthropic client (`anthropic`), OAuth sign-in and
  refresh (`oauth`), the Postgres store (`postgres`), or the inbound doors and
  `lf serve` (`serve`), and so without the TLS stack. Add any of those
  features back by name; a project that needs a missing one is refused by
  name.
- As a library (`default-features = false`), it re-exports the parser
  (`listen-fire-parser`), the checker (`listen-fire-checker`) and the engine
  (`listen-fire-engine`). Embed the engine with `engine::embed`: implement
  the host traits, check a movement, run it on an event.

Source and examples: https://github.com/listen-fire/listen-fire
