// The limits a run is held to while it runs: how deep its calls may nest, and
// how much of a file's text one read hands it. (The checks that refuse a
// nonsense setting at boot are in boot-checks.)

export { CallDepthExceeded, isCallDepthExceeded, maxCallDepth } from '../services/movement_engine/call_depth';
export { maxFileChars } from '../services/movement_engine/segment_limits';
