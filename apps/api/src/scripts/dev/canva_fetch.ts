// Verification for Canva link ingestion, driven through the real document
// source path against a live Canva deck (there is no fake for Canva).
//
//   1. the editor route people actually paste is recognised and rewritten to
//      the viewer route by the document-source layer;
//   2. the reader (@lf/web, Canva's source) crawls that deck through the
//      platform's browser slot and assembles a PDF.
//
// Run: pnpm --filter api exec ts-node --project tsconfig.dev.json \
//        --transpile-only -r dotenv/config -r tsconfig-paths/register \
//        src/scripts/dev/canva_fetch.ts <canva-url> <output.pdf>

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { DocumentSourceService } from '../../lib/document_sources';

async function main() {
  const [url, outputPath] = process.argv.slice(2);
  if (!url || !outputPath) {
    throw new Error('usage: canva_fetch.ts <canva-url> <output.pdf>');
  }

  const sanitized = DocumentSourceService.sanitizeUrl(url);
  console.log('supported:', DocumentSourceService.isSupportedUrl(url));
  console.log('output format:', DocumentSourceService.outputFormat(url));
  console.log('sanitized:', sanitized);

  const started = Date.now();
  const pdf = await DocumentSourceService.getUrlAsPdfStream(sanitized, {});
  if (!pdf) {
    throw new Error('the reader returned no PDF');
  }

  await pipeline(pdf.data, createWriteStream(outputPath));
  console.log(`wrote ${outputPath} ("${pdf.name}") in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
