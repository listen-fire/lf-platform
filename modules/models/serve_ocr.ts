#!/usr/bin/env node
// The process lf starts for the models module's OCR install
// (lf-external.ocr.yaml's `command`): it listens where lf says
// (`MODULE_SOCKET`) and prints the `listening …` line lf reads its address from.

import { serveSlot } from 'module-runtime/module-wire';

import { MODELS_OCR_MANIFEST, modelsOcrAnswer } from './ocr';

void serveSlot({ manifest: MODELS_OCR_MANIFEST, answer: modelsOcrAnswer(), print: true });
