#!/usr/bin/env node
// Starts the fake third-party services. The server is TypeScript run by tsx,
// in this process, so the caller's working directory (where it keeps its
// test-harness-data) and environment (FAKE_CHANNELS_PORT) are untouched.
require('tsx/cjs');
require('../src/index.ts');
