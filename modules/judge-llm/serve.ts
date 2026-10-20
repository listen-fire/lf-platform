#!/usr/bin/env node
// The process a host starts for the judge (lf-external.yaml's `command`): it
// listens where the host says (`MODULE_SOCKET`), prints the `listening …`
// line the host reads its address from, and asks the host's models door
// (LF_HOST_URL) for its model calls.

import { serveSlot } from 'module-runtime/module-wire';

import { JUDGE_LLM_MANIFEST, hostDoorFromEnv, judgeLlmAnswer } from './judge_slot';

void serveSlot({ manifest: JUDGE_LLM_MANIFEST, answer: judgeLlmAnswer(hostDoorFromEnv()), print: true });
