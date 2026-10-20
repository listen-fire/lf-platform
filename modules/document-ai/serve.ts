#!/usr/bin/env node
// The process lf starts for the Document AI module (lf-external.yaml's
// `command`): it listens where lf says (`MODULE_SOCKET`) and prints the
// `listening …` line lf reads its address from.

import { serveSlot } from 'module-runtime/module-wire';

import { DOCUMENT_AI_MANIFEST, documentAiAnswer } from './document_ai';

void serveSlot({ manifest: DOCUMENT_AI_MANIFEST, answer: documentAiAnswer(), print: true });
