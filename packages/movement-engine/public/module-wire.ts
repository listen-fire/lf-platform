// The one transport every module kind is reached over (adapter protocol 2's
// HTTP: a Unix socket on the same box, TCP, or HTTPS for a remote module): a
// client for any module's address, a server to serve a slot from, starting a
// module process, and the conformance cases that hold any slot server to its
// slot's meaning over the wire.

export * from '../services/module_wire/wire';
export * from '../services/module_wire/conformance';
