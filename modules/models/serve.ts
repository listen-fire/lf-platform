#!/usr/bin/env node
// The process lf starts for the models module (lf-external.yaml's `command`):
// it listens where lf says (`MODULE_SOCKET`) and prints the `listening …`
// line lf reads its address from.

import { serveSlot } from 'module-runtime/module-wire';

import { MODELS_MANIFEST, modelsAnswer } from './models';

void serveSlot({ manifest: MODELS_MANIFEST, answer: modelsAnswer(), print: true });
