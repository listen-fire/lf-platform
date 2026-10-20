#!/usr/bin/env node
// The process lf starts for a files module (lf-external.yaml's `command`): it
// listens where lf says (`MODULE_SOCKET`) and prints the `listening …` line
// lf reads its address from.

import { serveSlot } from 'module-runtime/module-wire';

import { S3_FILES_MANIFEST, s3FilesAnswer } from './s3_files';

void serveSlot({ manifest: S3_FILES_MANIFEST, answer: s3FilesAnswer(), print: true });
